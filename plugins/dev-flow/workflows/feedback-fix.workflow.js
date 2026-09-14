// claude-autopilot-kit / workflows/feedback-fix.workflow.js
//
// /auto-feedback "<コメント>" から起動されるフィードバック反映ループ。
// 自然言語コメントを構造化 → 修正方針 → 実装 → 再テスト → 再 QA → 動画再集約。
//
// 引数 (args):
//   {
//     task_id: string
//     feedback: string                // ユーザーの自然言語コメント
//     review_dir: string              // .agent/autopilot/<task_id>/review/
//     evidence_dir: string            // .agent/evidence/<task_id>/
//     requirements_path: string
//     design_path: string
//     dev_url: string
//     issue_number?: number
//     max_attempts?: number           // 既定 3（feedback は build より短く）
//     report_only?: boolean           // 既定 false。true なら RePlan までで停止し FixPlan レポートのみ返す（L1 report-only）
//     // ── Loop Engineering 由来の暴走防止ハードキャップ（2026-06-18 事例対策）──
//     max_commits?: number             // 既定 20（loop 全体の commit 上限）
//     max_token_per_attempt?: number   // 既定 500_000
//     scope_drift_threshold?: number   // 既定 0.3（supervisor が halt-scope-drift 判定する閾値）
//     supervisor_model?: string        // 任意。generator と別モデル推奨（例: 'claude-sonnet-4-6'）
//     stop_judge_model?: string        // 任意。fast model 推奨（例: 'claude-haiku-4-5-20251001'）
//   }

export const meta = {
  name: 'autopilot-feedback-fix',
  description: '自然言語フィードバックを構造化 → 修正 → 再試走 → 動画再集約まで完走',
  whenToUse: 'auto-feedback スキルが内部で起動する。直接呼び出しは推奨しない',
  phases: [
    { title: 'Interpret',           detail: 'feedback-interpreter で構造化' },
    { title: 'RePlan',              detail: '各項目の FixPlan を立てる' },
    { title: 'FixLoop',             detail: '修正→再テスト→再 QA → supervisor 判定 → stop-judge 判定（最大 max_attempts 巡 or supervisor が halt）' },
    { title: 'CollectReviewAssets', detail: '更新された E2E/QA 動画を review/ に再集約' },
    { title: 'Finalize',            detail: 'review-index 再生成・PR コメント追加' },
  ],
}

// 現行ハーネスは args を JSON-encoded string として注入する不具合があるため、
// string で来たら JSON.parse、object なら素通しの防御パースを行う。
// ハーネスが将来仕様通り object 注入に修正されても両対応で動く。
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const REPORT_ONLY = A.report_only === true
const MAX_ATTEMPTS = A.max_attempts ?? 3
const MAX_COMMITS = A.max_commits ?? 20
const MAX_TOKEN_PER_ATTEMPT = A.max_token_per_attempt ?? 500_000
const SCOPE_DRIFT_THRESHOLD = A.scope_drift_threshold ?? 0.3
const SUPERVISOR_MODEL = A.supervisor_model // undefined なら inherit
const STOP_JUDGE_MODEL = A.stop_judge_model // undefined なら inherit
const TASK_ID = A.task_id
const REVIEW_DIR = A.review_dir
const EVIDENCE_DIR = A.evidence_dir
const STATE_FILE = `.agent/autopilot/${A.task_id}/state.md`
const INBOX_DIR = `.agent/autopilot/${A.task_id}/inbox/`

if (!A.feedback || !TASK_ID || !REVIEW_DIR || !EVIDENCE_DIR) {
  throw new Error('feedback-fix.workflow.js: required args missing')
}

log(`autopilot-feedback start: task=${TASK_ID} feedback="${A.feedback.slice(0, 80)}..."${REPORT_ONLY ? ' / report-only (L1)' : ''}`)

// ───────────────────────────────────────────────────────────────────────────
// denylist（.agent/loop-denylist.txt）簡易 glob 照合
// hook（pre-edit-protect.sh）と同じマッチ規則: 「/」を含むパターンは相対パス、
// 含まないパターンは basename と照合。** は * と等価（/ を跨いでマッチ）。
// ───────────────────────────────────────────────────────────────────────────
function globMatch(str, pat) {
  const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(str)
}
function denylistHit(file, patterns) {
  const norm = String(file).replace(/^\.\//, '')
  const base = norm.split('/').pop()
  for (const p of patterns) {
    if (p.includes('/')) {
      const pat = p.replace(/\*\*/g, '*')
      if (globMatch(norm, pat) || globMatch('/' + norm, pat)) return p
    } else if (globMatch(base, p)) {
      return p
    }
  }
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// schema 定義（inline JSON Schema object）
// ───────────────────────────────────────────────────────────────────────────
// 現行 Workflow ランタイムの agent() は schema パラメータに inline JSON Schema object を要求するため、
// workflows/schemas/*.json の内容をここに直接埋め込んでいる。
// schemas/*.json は参照用として残しているが、ランタイムからは読み込まない。
const FEEDBACK_ITEMS_SCHEMA = {
  type: 'object',
  required: ['original', 'items'],
  properties: {
    original: { type: 'string' },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'category', 'intent', 'target_hint', 'priority'],
        properties: {
          id: { type: 'string', pattern: '^FB[0-9]+$' },
          category: {
            type: 'string',
            enum: ['bug', 'ui-improvement', 'spec-mismatch', 'spec-addition', 'performance', 'a11y', 'security'],
          },
          intent: { type: 'string' },
          target_hint: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          needs_clarification: { type: 'boolean' },
        },
      },
    },
  },
}

const TEST_RESULT_SCHEMA = {
  type: 'object',
  required: ['status', 'passed', 'failed', 'total'],
  properties: {
    status: { type: 'string', enum: ['all-pass', 'some-fail', 'all-fail', 'error'] },
    passed: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    total: { type: 'integer', minimum: 0 },
    duration_ms: { type: 'integer', minimum: 0 },
    failure_details: {
      type: 'array',
      items: {
        type: 'object',
        // Issue #2 P7: file は特定できない場合があるので required から外す
        required: ['test_name', 'message'],
        properties: {
          test_name: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          message: { type: 'string' },
          stack: { type: 'string' },
        },
      },
    },
    spec_paths: { type: 'array', items: { type: 'string' } },
    test_command: { type: 'string' },
  },
}

const BUILD_RESULT_SCHEMA = {
  type: 'object',
  // phase_id は build 本体 Phase 用。FixLoop では implementer を per-item で呼ぶため任意化。
  // src_files_created は Issue #2 P2: 実装ソースの明示申告（テスト・設定のみで済ませる逃避の防止）
  required: ['status', 'files_changed', 'commit_sha', 'src_files_created'],
  properties: {
    phase_id: { type: 'string', pattern: '^(P[0-9]+|FB[0-9]+|REG[0-9]+-[0-9]+)$' },
    status: { type: 'string', enum: ['success', 'partial', 'failed'] },
    files_changed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'change_type'],
        properties: {
          path: { type: 'string' },
          change_type: { type: 'string', enum: ['added', 'modified', 'deleted'] },
          lines_added: { type: 'integer', minimum: 0 },
          lines_deleted: { type: 'integer', minimum: 0 },
        },
      },
    },
    commit_sha: { type: 'string' },
    src_files_created: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const UNIT_REPORT_SCHEMA = {
  type: 'object',
  required: ['phase_id', 'test_result', 'lint_status', 'decision'],
  properties: {
    phase_id: { type: 'string' },
    test_result: TEST_RESULT_SCHEMA,
    lint_status: { type: 'string', enum: ['clean', 'warnings', 'errors', 'not-run'] },
    lint_messages: {
      type: 'array',
      items: {
        type: 'object',
        // Issue #2 P7: rule / severity は lint 出力形式に依存するため required から外す
        required: ['file', 'message'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          rule: { type: 'string' },
          message: { type: 'string' },
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        },
      },
    },
    decision: { type: 'string', enum: ['proceed', 'fix-required', 'abort'] },
    issues_for_fix_loop: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'target'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['Critical', 'Major', 'Minor'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          target: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

const QA_EVIDENCE_SCHEMA = {
  type: 'object',
  required: ['base_dir', 'exploration_log', 'videos'],
  properties: {
    base_dir: { type: 'string' },
    exploration_log: { type: 'string' },
    console_messages: { type: 'string' },
    network_requests: { type: 'string' },
    screenshots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'step', 'goal_id'],
        properties: {
          path: { type: 'string' },
          step: { type: 'string' },
          goal_id: { type: 'string' },
        },
      },
    },
    videos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'goal_id', 'duration_sec'],
        properties: {
          path: { type: 'string' },
          goal_id: { type: 'string' },
          duration_sec: { type: 'number' },
          size_bytes: { type: 'integer' },
        },
      },
    },
    recording_available: { type: 'boolean' },
  },
}

const QA_FINDING_SCHEMA = {
  type: 'object',
  required: ['evaluator', 'findings', 'summary'],
  properties: {
    evaluator: { type: 'string', enum: ['qa-goal-evaluator', 'qa-technical-evaluator', 'qa-ux-evaluator'] },
    summary: {
      type: 'object',
      required: ['critical', 'major', 'minor'],
      properties: {
        critical: { type: 'integer', minimum: 0 },
        major: { type: 'integer', minimum: 0 },
        minor: { type: 'integer', minimum: 0 },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'confidence', 'evidence_ref', 'recommendation'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['Critical', 'Major', 'Minor'] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          lens: { type: 'string' },
          evidence_ref: {
            type: 'object',
            properties: {
              screenshot: { type: 'string' },
              video: { type: 'string' },
              log_excerpt: { type: 'string' },
            },
          },
          recommendation: { type: 'string' },
        },
      },
    },
  },
}

const FIX_PLAN_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source_id', 'approach', 'files_to_change', 'test_impact'],
        properties: {
          source_id: { type: 'string' },
          approach: { type: 'string' },
          files_to_change: { type: 'array', items: { type: 'string' } },
          test_impact: {
            type: 'object',
            properties: {
              tests_to_add: { type: 'array', items: { type: 'string' } },
              tests_to_update: { type: 'array', items: { type: 'string' } },
            },
          },
          rollback_strategy: { type: 'string' },
        },
      },
    },
  },
}

const VIDEO_INDEX_SCHEMA = {
  type: 'object',
  required: ['source', 'videos'],
  properties: {
    source: { type: 'string', enum: ['e2e', 'qa'] },
    total_size_bytes: { type: 'integer', minimum: 0 },
    videos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['src_path', 'dest_path', 'label'],
        properties: {
          src_path: { type: 'string' },
          dest_path: { type: 'string' },
          label: { type: 'string' },
          duration_sec: { type: 'number' },
          size_bytes: { type: 'integer' },
          thumbnail_path: { type: 'string' },
        },
      },
    },
  },
}

const REVIEW_INDEX_SCHEMA = {
  type: 'object',
  required: ['task_id', 'review_dir', 'summary', 'videos', 'pr_url'],
  properties: {
    task_id: { type: 'string' },
    review_dir: { type: 'string' },
    summary: {
      type: 'object',
      required: ['total_attempts', 'final_status'],
      properties: {
        total_attempts: { type: 'integer', minimum: 1 },
        final_status: {
          type: 'string',
          enum: [
            'all-green',
            'partial-green',
            'halted-budget',
            'halted-attempts',
            'halted-error',
            // ── Loop Engineering 由来 ──
            'halted-supervisor',         // supervisor verdict = halt-scope-drift / halt-regression / halt-thrashing
            'halted-commits',            // 累積 commits ≥ max_commits
            'halted-token-per-attempt',  // 直前 attempt の token ≥ max_token_per_attempt
            'halted-checkpoint',         // supervisor verdict = escalate-human（人間判断要）
            'halted-denylist',           // 全修正項目が denylist 抵触（人間の手動対応 or denylist 見直し要）
          ],
        },
        unit_pass_rate: { type: 'number', minimum: 0, maximum: 1 },
        e2e_pass_rate: { type: 'number', minimum: 0, maximum: 1 },
        qa_critical_count: { type: 'integer', minimum: 0 },
        qa_major_count: { type: 'integer', minimum: 0 },
      },
    },
    videos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'category', 'path', 'recommended_speed'],
        properties: {
          label: { type: 'string' },
          category: { type: 'string', enum: ['e2e', 'qa-goal', 'qa-error', 'qa-ux'] },
          path: { type: 'string' },
          duration_sec: { type: 'number' },
          recommended_speed: { type: 'string', enum: ['0.5x', '1.0x', '1.5x'], default: '0.5x' },
          related_finding_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    release_asset_url: { type: 'string' },
    pr_url: { type: 'string' },
  },
}

// ── Loop Engineering: supervisor / stop-judge スキーマ（2026-06-18 暴走事例対策）──
const SUPERVISOR_VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reason', 'scores'],
  properties: {
    verdict: {
      type: 'string',
      enum: [
        'continue',
        'halt-scope-drift',
        'halt-regression',
        'halt-thrashing',
        'halt-commits',
        'halt-token-per-attempt',
        'escalate-human',
      ],
    },
    reason: { type: 'string', minLength: 10 },
    scores: {
      type: 'object',
      required: ['scope_drift', 'regression', 'thrashing', 'commits_used', 'tokens_last_attempt'],
      properties: {
        scope_drift: { type: 'number', minimum: 0, maximum: 1 },
        regression: { type: 'string', enum: ['none', 'minor', 'major'] },
        thrashing: { type: 'string', enum: ['none', 'suspected', 'confirmed'] },
        commits_used: { type: 'integer', minimum: 0 },
        tokens_last_attempt: { type: 'integer', minimum: 0 },
      },
    },
    next_action_hint: { type: 'string' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
  },
}

const STOP_JUDGE_SCHEMA = {
  type: 'object',
  required: ['done', 'checks', 'summary'],
  properties: {
    done: { type: 'boolean' },
    checks: {
      type: 'object',
      required: [
        'G1_unit_failed_zero',
        'G2_e2e_failed_zero',
        'G3_qa_critical_zero',
        'G4_qa_major_zero',
        'G5_all_goals_have_evidence',
        'G6_scope_drift_in_range',
      ],
      properties: {
        G1_unit_failed_zero: { type: 'boolean' },
        G2_e2e_failed_zero: { type: 'boolean' },
        G3_qa_critical_zero: { type: 'boolean' },
        G4_qa_major_zero: { type: 'boolean' },
        G5_all_goals_have_evidence: { type: 'boolean' },
        G6_scope_drift_in_range: { type: 'boolean' },
      },
    },
    unmet_goals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['goal_id', 'reason'],
        properties: {
          goal_id: { type: 'string' },
          reason: { type: 'string' },
          evidence_missing: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const ATTEMPT_DIFF_STATS_SCHEMA = {
  type: 'object',
  required: ['commits_in_attempt', 'files_changed', 'unexpected_files'],
  properties: {
    commits_in_attempt: { type: 'integer', minimum: 0 },
    files_changed: { type: 'array', items: { type: 'string' } },
    unexpected_files: { type: 'array', items: { type: 'string' } },
    diff_summary: { type: 'string' },
  },
}

const SCHEMA = {
  FEEDBACK_ITEMS:      FEEDBACK_ITEMS_SCHEMA,
  FIX_PLAN:            FIX_PLAN_SCHEMA,
  BUILD_RESULT:        BUILD_RESULT_SCHEMA,
  UNIT_REPORT:         UNIT_REPORT_SCHEMA,
  TEST_RESULT:         TEST_RESULT_SCHEMA,
  QA_EVIDENCE:         QA_EVIDENCE_SCHEMA,
  QA_FINDING:          QA_FINDING_SCHEMA,
  VIDEO_INDEX:         VIDEO_INDEX_SCHEMA,
  REVIEW_INDEX:        REVIEW_INDEX_SCHEMA,
  SUPERVISOR_VERDICT:  SUPERVISOR_VERDICT_SCHEMA,
  STOP_JUDGE:          STOP_JUDGE_SCHEMA,
  ATTEMPT_DIFF_STATS:  ATTEMPT_DIFF_STATS_SCHEMA,
}

// ── Issue #2 P3: StructuredOutput 呼び忘れ・null 返しへのリトライラッパ ──
// schema 付き agent() は subagent が StructuredOutput を呼ばずに終了すると throw する。
// その場合はプロンプトにリトライ指示を追記して最大 maxRetry 回まで再試行する。
async function schemaAgent(prompt, opts, maxRetry = 2) {
  let lastErr
  for (let i = 0; i <= maxRetry; i++) {
    try {
      const result = await agent(prompt, opts)
      if (result != null) return result
      lastErr = new Error(`agent returned null (attempt ${i + 1})`)
    } catch (e) {
      lastErr = e
      // StructuredOutput 未呼び出しはプロンプトを増強してリトライ
      if (String(e.message).includes('StructuredOutput')) {
        prompt = prompt + '\n\n【リトライ】前回の呼び出しで StructuredOutput ツールを呼び忘れています。今回は必ず最後に StructuredOutput ツールを呼び出して結果を返してください。'
        continue
      }
      throw e
    }
  }
  throw lastErr
}

// ── Issue #2 P6: baseline SHA と state.md を Interpret より前に無条件で初期化 ──
// （FixLoop まで到達せず fatal した場合でも state / inbox の骨格が残るようにする）
let loopBaselineSha = await agent(
  `現在の HEAD コミット SHA を返してください。\`git rev-parse HEAD\` の出力1行のみ。`,
  { label: 'init/loop-baseline-sha' }
)
loopBaselineSha = typeof loopBaselineSha === 'string' ? loopBaselineSha.trim().split(/\s+/)[0] : ''

// state.md を初期化（既存があれば後段で append）
await agent(
  `${STATE_FILE} に以下の内容で state ファイルを初期化（追記モード推奨、既存なら上書きせず append）してください。
親ディレクトリが無ければ \`mkdir -p\` で作成。\`${INBOX_DIR}\` も同様に作成（空でよい）。

\`\`\`
# autopilot-feedback-fix state — ${TASK_ID}
- feedback: "${(A.feedback || '').slice(0, 120).replace(/\n/g, ' ')}"
- max_attempts: ${MAX_ATTEMPTS}
- max_commits: ${MAX_COMMITS}
- max_token_per_attempt: ${MAX_TOKEN_PER_ATTEMPT}
- scope_drift_threshold: ${SCOPE_DRIFT_THRESHOLD}
- loop_baseline_sha: ${loopBaselineSha}

| attempt | commits | tokens | unit_pass | e2e_pass | qa_C | qa_M | verdict | done | reason |
|---|---|---|---|---|---|---|---|---|---|
\`\`\``,
  { label: 'init/state-init' }
)

// ── Issue #2 P6: fatal 時も inbox に申し送りを残すため、以降の全 phase を try/catch で包む ──
// 差分最小化のため try ブロック内は意図的に再インデントしていない。
try {

// ── denylist 読み込み（Loop Engineering: 自動編集禁止パス。ファイルが無ければ空）──
let denylistPatterns = []
{
  const denyRaw = await agent(
    `プロジェクトの .agent/loop-denylist.txt を Read し、コメント（# 以降）と空行を除いたパターン行だけを1行1パターンで返してください。ファイルが存在しない場合は NONE とだけ返してください。`,
    { label: 'init/denylist-load' }
  )
  if (typeof denyRaw === 'string' && denyRaw.trim() && denyRaw.trim() !== 'NONE') {
    denylistPatterns = denyRaw.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
  }
}
const DENY_NOTE = denylistPatterns.length
  ? `\n自動編集禁止パス（denylist）: ${denylistPatterns.join(', ')} — これらに一致するファイルは Write/Edit しないこと。修正に必須なら実装せず notes に理由を書いて返すこと。`
  : ''
log(`denylist: ${denylistPatterns.length} patterns loaded`)

// ───────────────────────────────────────────────────────────────────────────
// Phase 1: Interpret
// ───────────────────────────────────────────────────────────────────────────
phase('Interpret')
const items = await schemaAgent(
  `あなたは feedback-interpreter エージェントです。
ユーザーから以下のレビューコメントを受領しました:
"""
${A.feedback}
"""
これを FeedbackItems schema の items に分解してください。
- category は bug / ui-improvement / spec-mismatch / spec-addition / performance / a11y / security のいずれか
- intent はユーザーが望む変更を簡潔に
- target_hint は ${A.requirements_path} と ${A.design_path} を参照しつつ、関係しそうなファイル・画面・機能を推定
- 不明瞭な点があれば needs_clarification=true にマークしてください（後でレポートに残します）`,
  { schema: SCHEMA.FEEDBACK_ITEMS, agentType: 'dev-flow:feedback-interpreter', label: 'interpret' }
)

if (!items?.items?.length) {
  throw new Error('Interpret phase: no feedback items derived')
}
log(`Interpret: ${items.items.length} items derived`)

const unclear = items.items.filter(i => i.needs_clarification)
if (unclear.length) {
  log(`WARN: ${unclear.length} items need clarification (continuing with remaining items, will report at end)`)
}

const actionable = items.items.filter(i => !i.needs_clarification)

// ───────────────────────────────────────────────────────────────────────────
// Phase 2: RePlan
// ───────────────────────────────────────────────────────────────────────────
phase('RePlan')
const fixPlan = await schemaAgent(
  `以下の FeedbackItems を FixPlan に変換してください。
items: ${JSON.stringify(actionable, null, 2)}
- 各項目に approach (1-3 文)、files_to_change、test_impact、rollback_strategy を必ず含める
- 副作用の小さい変更（UI・文言）と大きい変更（ロジック・スキーマ）を分けて優先順位を組む`,
  { schema: SCHEMA.FIX_PLAN, label: 'replan' }
)

log(`RePlan: ${fixPlan.items.length} fix items planned`)

// ── L1 report-only: RePlan までで停止し、修正を実行せず FixPlan レポートだけ返す ──
if (REPORT_ONLY) {
  const reportPath = `.agent/autopilot/${TASK_ID}/report-only.md`
  await agent(
    `${reportPath} に report-only モード（L1）のフィードバック反映計画レポートを Markdown で書いてください。
内容:
- 構造化した FeedbackItems（needs_clarification 含む）: ${JSON.stringify(items.items, null, 2)}
- FixPlan（そのまま転載）: ${JSON.stringify(fixPlan.items, null, 2)}
- denylist（${denylistPatterns.length} 件: ${denylistPatterns.join(', ') || 'なし'}）に抵触する項目があれば警告
- 概算コスト見積り: 修正項目あたり 50k-150k token + 再テスト/再QA 1巡 100k-300k token を目安に合計を出す
- 本実行への案内: 「この計画で問題なければ report_only を外して /auto-feedback を再実行」
**コードの変更・コミットは一切行わないこと。**`,
    { label: 'replan/report-only', phase: 'RePlan' }
  )
  await agent(
    `${STATE_FILE} の末尾に1行 append してください: \`- report-only run: ${fixPlan.items.length} fix items planned（修正なし）\``,
    { label: 'replan/report-only-state', phase: 'RePlan' }
  )
  log(`report-only: ${fixPlan.items.length} fix items planned — 修正せず終了`)
  return {
    task_id: TASK_ID,
    final_status: 'report-only',
    attempts: 0,
    items_consumed: actionable.length,
    items_unclear: unclear,
    open_issues: [],
    fix_plan: fixPlan,
    report_path: reportPath,
    commits_used: 0,
    state_file: STATE_FILE,
    inbox_dir: INBOX_DIR,
    loop_baseline_sha: loopBaselineSha,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 3: FixLoop
// Loop Engineering 適用: 各 attempt 末尾で
//   (1) attempt の差分統計を取得
//   (2) loop-supervisor が continue/halt を判定（generator/evaluator 分離）
//   (3) stop-judge が完了判定（fresh model、maker-checker）
//   (4) state.md に attempt 履歴を persist（次 attempt の冒頭で参照）
// ───────────────────────────────────────────────────────────────────────────
phase('FixLoop')
let attempt = 0
let pending = [...fixPlan.items]
let openIssues = []
let commitsUsed = 0
let supervisorVerdict = null
let stopJudgeResult = null
let prevUnitPassed = null
let prevE2ePassed = null
let earlyExitStatus = null
// 初回 FixPlan の files_to_change をループ全体の許容スコープとして固定し、
// 回帰 attempt で pending を rebuild しても declaredFilesSet が縮退しないようにする（#4 対策）
const loopDeclaredFiles = new Set(fixPlan.items.flatMap(i => i.files_to_change || []))
// denylist 抵触で escalate した修正項目（source_id）の累積
const denylistEscalations = []

while (
  pending.length > 0 &&
  attempt < MAX_ATTEMPTS &&
  budget.remaining() > 50_000 &&
  !earlyExitStatus
) {
  attempt++
  const tokenBeforeAttempt = budget.spent()
  log(`FixLoop attempt ${attempt}/${MAX_ATTEMPTS}: ${pending.length} items, ${openIssues.length} regressions, commits_used=${commitsUsed}`)

  const attemptStartSha = await agent(
    `現在の HEAD コミット SHA を返してください。\`git rev-parse HEAD\` の出力1行のみ。`,
    { label: `fix/attempt-start-sha-${attempt}`, phase: 'FixLoop' }
  )
  const attemptStartShaClean = typeof attemptStartSha === 'string' ? attemptStartSha.trim().split(/\s+/)[0] : ''

  // ── denylist 照合（機械層）: 抵触 item は実行せず inbox へ escalate ──
  if (denylistPatterns.length && pending.length) {
    const blocked = pending.filter(i => (i.files_to_change || []).some(f => denylistHit(f, denylistPatterns)))
    if (blocked.length) {
      pending = pending.filter(i => !blocked.includes(i))
      denylistEscalations.push(...blocked.map(i => i.source_id))
      await agent(
        `${INBOX_DIR}attempt-${attempt}-denylist.md に以下の内容で申し送り書を書いてください:

# denylist escalate (attempt ${attempt})
以下の修正項目は .agent/loop-denylist.txt の自動編集禁止パスに抵触するため実行しませんでした。
人間の手動対応、または denylist の見直しが必要です。

${JSON.stringify(blocked.map(i => ({ source_id: i.source_id, approach: i.approach, files_to_change: i.files_to_change })), null, 2)}`,
        { label: `fix/denylist-escalate-${attempt}`, phase: 'FixLoop' }
      )
      log(`⚠ denylist: ${blocked.length} 件の修正項目を escalate（実行せず）`)
      if (pending.length === 0) {
        earlyExitStatus = 'halted-denylist'
        log(`HALT: 全修正項目が denylist 抵触。人間判断が必要`)
        break
      }
    }
  }

  // 今 attempt の pending が宣言したファイルを loopDeclaredFiles に accumulate（monotonic）。
  // これにより回帰 attempt で pending が貧弱でも、過去 attempt の宣言が scope として残る（#4 対策）。
  for (const f of pending.flatMap(i => i.files_to_change || [])) loopDeclaredFiles.add(f)
  const declaredFilesSet = new Set(loopDeclaredFiles)

  // 各項目を implementer に sequential で流す（並列だと git index.lock 競合のため、#9 対策）
  const buildResults = []
  for (const item of pending) {
    const r = await schemaAgent(
      `implementer として ${item.source_id} のフィードバック反映を実行してください。
方針: ${item.approach}
対象: ${item.files_to_change.join(', ')}
テスト更新: ${JSON.stringify(item.test_impact)}
**スコープ厳守**: 上記 files_to_change 以外のファイルは触らないこと。やむを得ず触る場合は理由を notes に必ず記載。${DENY_NOTE}
実装ロジックの修正は実装ソースディレクトリ（src/ 等）で行い、tests/ 配下のモックで辻褄を合わせるのは禁止。
src_files_created には修正した実装ソースファイルを列挙すること（テスト・設定のみの修正なら空配列でよい）。
全テスト PASS と lint クリーンを確認してから feat: または fix: コミットを作成。
- ui-improvement / spec-addition → feat:
- bug / spec-mismatch → fix:

注意: phase_id フィールドは FixLoop コンテキストでは "${item.source_id}" をそのまま入れて返してください（FB1 / REG1-2 等）。`,
      { schema: SCHEMA.BUILD_RESULT, agentType: 'dev-flow:implementer', label: `fix/${item.source_id}-a${attempt}`, phase: 'FixLoop' }
    )
    buildResults.push(r)
  }
  // 実 commit 数は diffStats.commits_in_attempt から取得するためここでは集計しない（#2 対策）

  // 全テスト＋E2E＋QA 再試走
  const reRunUnit = await schemaAgent(
    `全ユニットテストと lint を再実行し、UnitReport schema で返してください。
失敗ログは message に全文を貼らず 3 行以内に要約すること。`,
    { schema: SCHEMA.UNIT_REPORT, label: `fix/unit-rerun-${attempt}`, phase: 'FixLoop' }
  )
  const reRunE2E = await schemaAgent(
    `npm run test:e2e を再実行し、TestResult schema で返してください。
新たに生成された video.webm のパスを failure_details.message に必ず含めること。
エラーログ自体は 3 行以内に要約すること。`,
    { schema: SCHEMA.TEST_RESULT, label: `fix/e2e-rerun-${attempt}`, phase: 'FixLoop' }
  )

  // QA 再探索（影響箇所周辺のみ）
  const qaReExplore = await schemaAgent(
    `qa-explorer として今回のフィードバック対象画面を中心に Playwright で再探索してください。
全ゴール再走破は不要。影響範囲のみ。動画は ${EVIDENCE_DIR}qa/videos/ に保存（新世代として）。
QAEvidence schema で証跡目録を返してください。`,
    { schema: SCHEMA.QA_EVIDENCE, agentType: 'dev-flow:qa-explorer', label: `fix/qa-rerun-${attempt}`, phase: 'FixLoop' }
  )

  const qaReFindings = await parallel([
    () => schemaAgent(
      `qa-goal-evaluator として ${qaReExplore.base_dir} の証跡からゴール到達を再評価。confidence 必須。`,
      { schema: SCHEMA.QA_FINDING, agentType: 'dev-flow:qa-goal-evaluator', label: `fix/qa-goal-${attempt}`, phase: 'FixLoop' }
    ),
    () => schemaAgent(
      `qa-technical-evaluator として ${qaReExplore.base_dir} の技術エラーを再評価。confidence 必須。`,
      { schema: SCHEMA.QA_FINDING, agentType: 'dev-flow:qa-technical-evaluator', label: `fix/qa-tech-${attempt}`, phase: 'FixLoop' }
    ),
    () => schemaAgent(
      `qa-ux-evaluator として ${qaReExplore.base_dir} の UI/UX を再評価。confidence 必須。`,
      { schema: SCHEMA.QA_FINDING, agentType: 'dev-flow:qa-ux-evaluator', label: `fix/qa-ux-${attempt}`, phase: 'FixLoop' }
    ),
  ])

  const qaCritical = qaReFindings.filter(Boolean).flatMap(f => f.findings || []).filter(f => f.severity === 'Critical')
  const qaMajor    = qaReFindings.filter(Boolean).flatMap(f => f.findings || []).filter(f => f.severity === 'Major')

  const unitPassed = reRunUnit?.test_result?.passed ?? 0
  const e2ePassed  = (reRunE2E?.passed ?? 0)
  // ※ tokensThisAttempt は supervisor / stop-judge / state-append 完了後に再計測する（#6 対策）

  // ── (1) attempt の差分統計を取得 ──────────────────────────────────
  const diffStats = await schemaAgent(
    `直前 attempt (${attemptStartShaClean}..HEAD) の差分統計を返してください。
- \`git log --oneline ${attemptStartShaClean}..HEAD | wc -l\` で commits_in_attempt
- \`git diff --name-only ${attemptStartShaClean}..HEAD\` で files_changed[]
- 宣言された files_to_change[] = ${JSON.stringify([...declaredFilesSet])}
- 上記宣言に含まれないファイルを unexpected_files[] にリストアップ
- \`git diff --stat ${attemptStartShaClean}..HEAD\` のサマリを diff_summary に
AttemptDiffStats schema で返答。`,
    { schema: SCHEMA.ATTEMPT_DIFF_STATS, label: `fix/diff-stats-${attempt}`, phase: 'FixLoop' }
  )

  // 実 commit 数は diffStats から取得する（commit_sha 個数では 1 item 複数 commit を undercount するため、#2 対策）
  const commitsInAttempt = diffStats?.commits_in_attempt ?? 0
  commitsUsed += commitsInAttempt

  // ── (2) loop-supervisor が continue/halt を判定 ─────────────────
  supervisorVerdict = await schemaAgent(
    `loop-supervisor として attempt ${attempt} の続行判定を行ってください。

# 元のゴール（FeedbackItems）
${JSON.stringify(actionable, null, 2)}

# 直前 attempt の差分統計
${JSON.stringify(diffStats, null, 2)}

# 直前 attempt のテスト結果
- unit: passed=${unitPassed} failed=${reRunUnit?.test_result?.failed ?? 0} total=${reRunUnit?.test_result?.total ?? 0}
- e2e: passed=${e2ePassed} failed=${reRunE2E?.failed ?? 0} total=${reRunE2E?.total ?? 0}
- qa: critical=${qaCritical.length} major=${qaMajor.length}

# 前 attempt との比較（回帰検出用）
- prev_unit_passed: ${prevUnitPassed ?? 'N/A (first attempt)'}
- prev_e2e_passed: ${prevE2ePassed ?? 'N/A (first attempt)'}

# コスト情報
- 累積 commits since loop start: ${commitsUsed}
- 直前 attempt 追加 commits: ${commitsInAttempt}
- 直前 attempt token (中間値): ${budget.spent() - tokenBeforeAttempt}

# ハードキャップ
- max_commits: ${MAX_COMMITS}
- max_token_per_attempt: ${MAX_TOKEN_PER_ATTEMPT}
- scope_drift_threshold: ${SCOPE_DRIFT_THRESHOLD}

# 過去 attempt 履歴
${STATE_FILE} を Read して履歴を把握してください。

# 判定指示
SupervisorVerdict schema に従って verdict / reason / scores を返してください。
broken until proven のスタンスで、continue を選ぶなら積極的根拠を reason に書くこと。`,
    {
      schema: SCHEMA.SUPERVISOR_VERDICT,
      agentType: 'dev-flow:loop-supervisor',
      label: `fix/supervisor-${attempt}`,
      phase: 'FixLoop',
      ...(SUPERVISOR_MODEL ? { model: SUPERVISOR_MODEL } : {}),
    }
  )

  // ── (3) stop-judge が完了判定（supervisor とは独立に呼ぶ）────────
  stopJudgeResult = await schemaAgent(
    `stop-judge として attempt ${attempt} 終了時点でゴール到達したか判定してください。

# 元のゴール（FeedbackItems）
${JSON.stringify(actionable, null, 2)}

# 最新テスト結果
- unit: failed=${reRunUnit?.test_result?.failed ?? 0} passed=${unitPassed} total=${reRunUnit?.test_result?.total ?? 0}
- e2e: failed=${reRunE2E?.failed ?? 0} passed=${e2ePassed} total=${reRunE2E?.total ?? 0}
- qa: critical=${qaCritical.length} major=${qaMajor.length}

# スコープ宣言
files_to_change[] = ${JSON.stringify([...declaredFilesSet])}

# 直前 attempt の diff 統計
${JSON.stringify(diffStats, null, 2)}

StopJudge schema で done / checks / unmet_goals を返してください。
unmet until proven met のスタンスで、疑わしければ done=false にすること。`,
    {
      schema: SCHEMA.STOP_JUDGE,
      agentType: 'dev-flow:stop-judge',
      label: `fix/stop-judge-${attempt}`,
      phase: 'FixLoop',
      ...(STOP_JUDGE_MODEL ? { model: STOP_JUDGE_MODEL } : {}),
    }
  )

  // ── halt 経路でも残課題が表示されるように openIssues を先に再構築する（#5 対策）──
  openIssues = [
    ...(reRunUnit?.issues_for_fix_loop || []).filter(i => i.severity === 'Critical' || i.severity === 'Major'),
    ...(reRunE2E?.failure_details || []).map(f => ({
      title: `E2E fail: ${f.test_name}`, severity: 'Critical', confidence: 100,
      target: `${f.file || '?'}:${f.line || ''}`, recommendation: f.message,
    })),
    ...qaCritical,
    ...qaMajor,
  ]

  // tokensThisAttempt はガード agent (diff-stats/supervisor/stop-judge) の消費も含めて再計測（#6 対策）
  const tokensThisAttempt = budget.spent() - tokenBeforeAttempt

  // ── (4) state.md に attempt 履歴を persist ─────────────────────
  await agent(
    `${STATE_FILE} に attempt ${attempt} の行を append してください（既存テーブルに1行追加）:
| ${attempt} | ${commitsInAttempt} (累計 ${commitsUsed}) | ${tokensThisAttempt} | ${unitPassed} | ${e2ePassed} | ${qaCritical.length} | ${qaMajor.length} | ${supervisorVerdict?.verdict ?? 'unknown'} | ${stopJudgeResult?.done ?? 'unknown'} | ${(supervisorVerdict?.reason ?? '').slice(0, 80).replace(/\|/g, '\\|')} |`,
    { label: `fix/state-append-${attempt}`, phase: 'FixLoop' }
  )

  prevUnitPassed = unitPassed
  prevE2ePassed = e2ePassed

  // ── 判定順序（stop-judge.md / loop-supervisor.md のプロトコル準拠）──
  // 優先順:
  //   1. stop-judge.done=true なら all-green（ハードキャップより優先、#1 対策）
  //   2. supervisor null/verdict 欠落なら halted-error（無監督継続を防ぐ、#8 対策）
  //   3. ハードキャップ (commits / token)
  //   4. JS 側 scope_drift 二重チェック (#10 対策)
  //   5. supervisor verdict が halt-* / escalate-human

  const computedScopeDrift = (diffStats?.files_changed?.length ?? 0) > 0
    ? (diffStats?.unexpected_files?.length ?? 0) / diffStats.files_changed.length
    : 0

  if (stopJudgeResult?.done === true) {
    earlyExitStatus = 'all-green'
    log(`DONE: stop-judge says done=true at attempt ${attempt}`)
  } else if (!supervisorVerdict || typeof supervisorVerdict.verdict !== 'string') {
    earlyExitStatus = 'halted-error'
    log(`HALT: supervisor returned null/invalid verdict at attempt ${attempt}`)
  } else if (commitsUsed >= MAX_COMMITS) {
    earlyExitStatus = 'halted-commits'
    log(`HALT: commits_used=${commitsUsed} >= max_commits=${MAX_COMMITS}`)
  } else if (tokensThisAttempt >= MAX_TOKEN_PER_ATTEMPT) {
    earlyExitStatus = 'halted-token-per-attempt'
    log(`HALT: tokens_this_attempt=${tokensThisAttempt} >= max_token_per_attempt=${MAX_TOKEN_PER_ATTEMPT}`)
  } else if (computedScopeDrift > SCOPE_DRIFT_THRESHOLD) {
    earlyExitStatus = 'halted-supervisor'
    log(`HALT: computed_scope_drift=${computedScopeDrift.toFixed(2)} > threshold=${SCOPE_DRIFT_THRESHOLD} (JS-side defense, #10)`)
  } else if (supervisorVerdict.verdict !== 'continue') {
    if (supervisorVerdict.verdict === 'escalate-human') {
      earlyExitStatus = 'halted-checkpoint'
    } else {
      earlyExitStatus = supervisorVerdict.verdict.startsWith('halt-commits')
        ? 'halted-commits'
        : supervisorVerdict.verdict.startsWith('halt-token')
          ? 'halted-token-per-attempt'
          : 'halted-supervisor'
    }
    log(`HALT: supervisor verdict=${supervisorVerdict.verdict} reason="${supervisorVerdict.reason}"`)
  }

  // halt 時は inbox/ に申し送り書類を残す
  if (earlyExitStatus && earlyExitStatus !== 'all-green') {
    await agent(
      `${INBOX_DIR}attempt-${attempt}-halted.md に以下の内容で halt 申し送り書を出力してください:

\`\`\`md
# Halted at attempt ${attempt}
- final_status: ${earlyExitStatus}
- supervisor.verdict: ${supervisorVerdict?.verdict ?? 'N/A'}
- supervisor.reason: ${supervisorVerdict?.reason ?? 'N/A'}
- supervisor.scores: ${JSON.stringify(supervisorVerdict?.scores ?? {})}
- stop_judge.done: ${stopJudgeResult?.done ?? 'N/A'}
- stop_judge.unmet_goals: ${JSON.stringify(stopJudgeResult?.unmet_goals ?? [])}
- commits_used: ${commitsUsed}
- tokens_last_attempt: ${tokensThisAttempt}
- computed_scope_drift: ${computedScopeDrift.toFixed(2)}
- diff_summary: ${(diffStats?.diff_summary ?? '').slice(0, 400)}
- unexpected_files: ${JSON.stringify(diffStats?.unexpected_files ?? [])}
- open_issues_count: ${openIssues.length}

## 人間が確認すべき項目
1. supervisor の reason と evidence_refs を読む
2. diff_summary と unexpected_files が想定スコープ内か確認
3. 続行する場合は問題箇所を解消してから /auto-feedback で再開
4. ロールバックする場合は loop_baseline_sha=${loopBaselineSha} に \`git reset\`
\`\`\``,
      { label: `fix/inbox-halt-${attempt}`, phase: 'FixLoop' }
    )
    break
  }

  // 続行するなら次 attempt の pending を再構築（openIssues は既に上で計算済み）
  pending = openIssues.map((iss, i) => ({
    source_id: `REG${attempt}-${i + 1}`,
    approach: iss.recommendation || `${iss.title} の回帰修正`,
    files_to_change: iss.target ? [iss.target.split(':')[0]] : [],
    test_impact: { tests_to_add: [], tests_to_update: [] },
  }))
}

// 自然終了パスでも stop-judge の done を最終判定に組み込む（#3 対策）。
// openIssues=0 だけで all-green と決めず、stop-judge が done=false（証跡不足等）なら halted-checkpoint。
const naturalAllGreen = openIssues.length === 0 && stopJudgeResult?.done === true
const naturalIncomplete = openIssues.length === 0 && stopJudgeResult && stopJudgeResult.done === false

const finalStatus = earlyExitStatus
  ?? (naturalAllGreen              ? 'all-green' :
      naturalIncomplete            ? 'halted-checkpoint' :
      attempt >= MAX_ATTEMPTS      ? 'halted-attempts' :
      budget.remaining() <= 50_000 ? 'halted-budget' :
                                      'partial-green')

log(`FixLoop done: status=${finalStatus} attempts=${attempt} commits_used=${commitsUsed}`)

// ───────────────────────────────────────────────────────────────────────────
// Phase 4: CollectReviewAssets — 新世代の動画を集約
// ───────────────────────────────────────────────────────────────────────────
phase('CollectReviewAssets')
await parallel([
  () => schemaAgent(
    `e2e/test-results/ の最新 video.webm を ${REVIEW_DIR}videos/e2e/ に上書きコピーし、
VideoIndex schema (source: "e2e") で返してください。`,
    { schema: SCHEMA.VIDEO_INDEX, label: 'collect/e2e-fb', phase: 'CollectReviewAssets' }
  ),
  () => schemaAgent(
    `${EVIDENCE_DIR}qa/videos/ の最新動画を ${REVIEW_DIR}videos/qa/ に上書きコピーし、
VideoIndex schema (source: "qa") で返してください。録画なしなら videos=[] でよい。`,
    { schema: SCHEMA.VIDEO_INDEX, label: 'collect/qa-fb', phase: 'CollectReviewAssets' }
  ),
])

// ───────────────────────────────────────────────────────────────────────────
// Phase 5: Finalize
// ───────────────────────────────────────────────────────────────────────────
phase('Finalize')
const reviewIndex = await schemaAgent(
  `ReviewIndex schema で更新後のレビュー用統合インデックスを返してください。
- task_id: ${TASK_ID}
- final_status: ${finalStatus}
- total_attempts: ${attempt + 1}
- 不明瞭フィードバック (needs_clarification): ${unclear.length} 件あれば末尾に列挙
${REVIEW_DIR}review-video-index.md を上書きで再生成すること。`,
  { schema: SCHEMA.REVIEW_INDEX, label: 'finalize/review-index-fb', phase: 'Finalize' }
)

// 変更理解ドキュメント（explain-diff）再生成 — フィードバック反映後の差分を人間が理解するため
// 失敗しても workflow は止めない（agent 側が "skipped" を返す）
const explainDocRaw = await agent(
  `あなたは explain-diff-generator エージェントです。
フィードバック反映（task_id: ${TASK_ID}）後のブランチ全体の変更を対象に、変更理解ドキュメントを生成してください。
- 対象 diff: \`git diff origin/main..HEAD\`（空なら "skipped" を返す）
- 文脈: 今回消化したフィードバック ${actionable.length} 項目・関連 Issue #${A.issue_number ?? '(なし)'} があれば読むこと
- 出力: 対象リポジトリの .agent/explanations/<今日の日付 YYYY-MM-DD>-<slug>.html（自己完結型 HTML・日本語・4部構成: 背景→直感→コード解説→理解度クイズ5問。ドキュメント保管規約）
- 最終出力は生成した HTML の絶対パスのみ。失敗時は "skipped" とだけ返す。`,
  { agentType: 'dev-flow:explain-diff-generator', label: 'finalize/explain-diff-fb', phase: 'Finalize' }
)
const explainDoc = (typeof explainDocRaw === 'string' && explainDocRaw.trim().startsWith('/'))
  ? explainDocRaw.trim() : null

await agent(
  `既存 PR (issue #${A.issue_number ?? 'N/A'}) にコメントを追加してください。
- フィードバック反映完了: ${actionable.length} 項目消化
- 最終ステータス: ${finalStatus} / 試行回数: ${attempt + 1}
- 更新された動画: ${REVIEW_DIR}videos/
- 不明瞭フィードバック: ${unclear.length === 0 ? 'なし' : JSON.stringify(unclear)}
gh pr comment <PR番号> --body-file <一時ファイル> で投稿。
PR 番号が分からなければ gh pr list --head <current branch> から取得。`,
  { label: 'finalize/pr-comment', phase: 'Finalize' }
)

return {
  task_id: TASK_ID,
  final_status: finalStatus,
  attempts: attempt + 1,
  items_consumed: actionable.length,
  items_unclear: unclear,
  open_issues: openIssues,
  review_index: reviewIndex,
  explain_doc: explainDoc,
  // ── Loop Engineering 由来: 呼び出し側（auto-feedback skill）が halted-* 時に
  //    AskUserQuestion で人間に渡すために必要な情報を返す ──
  supervisor_verdict: supervisorVerdict,
  stop_judge: stopJudgeResult,
  commits_used: commitsUsed,
  denylist_escalations: denylistEscalations,
  state_file: STATE_FILE,
  inbox_dir: INBOX_DIR,
  loop_baseline_sha: loopBaselineSha,
}

} catch (fatalErr) {
  // ── Issue #2 P6: fatal でも人間向けの申し送り（inbox/fatal-halt.md）を残してから落とす ──
  log(`FATAL: ${fatalErr.message}`)
  await agent(
    `${INBOX_DIR}fatal-halt.md に以下の内容で fatal 申し送り書を作成してください（親ディレクトリが無ければ \`mkdir -p\`）:

\`\`\`md
# Fatal halt — ${TASK_ID}
- error: ${String(fatalErr.message).slice(0, 400)}
- loop_baseline_sha: ${loopBaselineSha || '(未取得)'}
- open_issues: []（fatal のため不明）
- 推奨: /auto-feedback を再起動する前に FATAL の原因を除去すること
- ロールバック手順: git reset --hard ${loopBaselineSha || '<loop_baseline_sha>'}
\`\`\``,
    { label: 'finalize/fatal-inbox' }
  )
  throw fatalErr
}
