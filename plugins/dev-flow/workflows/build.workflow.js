// claude-autopilot-kit / workflows/build.workflow.js
//
// /auto-build から起動される自律実装ループ Workflow。
// DESIGN.md を入力に、実装→テスト→E2E→QA→修正ループを完走する。
//
// 引数 (args):
//   {
//     task_id: string                 // 例: "20260615-1530"
//     requirements_path: string       // REQUIREMENTS.md 絶対パス
//     design_path: string             // DESIGN.md 絶対パス
//     issue_number: number | null     // GitHub Issue 番号（あれば）
//     review_dir: string              // .agent/autopilot/<task_id>/review/
//     evidence_dir: string            // .agent/evidence/<task_id>/
//     dev_url: string                 // localhost 起動 URL
//     auth?: { email: string, password: string }
//     base_branch: string             // 通常 "main"
//     max_attempts?: number           // 既定 5
//     report_only?: boolean           // 既定 false。true なら Plan までで停止し実装計画レポートのみ返す（L1 report-only）
//     create_pr?: boolean             // 既定 true。false なら Finalize で PR 作成・Release アップロードをスキップ（loop-eval 等、リモートの無いリポジトリ向け）
//     // ── Loop Engineering 由来の暴走防止ハードキャップ（2026-06-18 事例対策）──
//     max_commits?: number             // 既定 30（build は feedback より多めの commit を許容）
//     max_token_per_attempt?: number   // 既定 800_000
//     scope_drift_threshold?: number   // 既定 0.4（build は phase 分のスコープがあるので feedback より緩め）
//     supervisor_model?: string        // 任意。generator と別モデル推奨（例: 'claude-sonnet-4-6'）
//     stop_judge_model?: string        // 任意。fast model 推奨（例: 'claude-haiku-4-5-20251001'）
//   }

export const meta = {
  name: 'autopilot-build',
  description: '設計→実装→ユニット→E2E→QA→修正ループを Critical/Major 0件まで自律完走する',
  whenToUse: 'auto-build スキルが内部で起動する。直接呼び出しは推奨しない',
  phases: [
    { title: 'Plan',                detail: 'DESIGN.md から Phase 分割' },
    { title: 'Build',               detail: '各Phase: test-writer → implementer → unit 試走（pipeline）' },
    { title: 'Integrate',           detail: 'E2E テスト生成・実行' },
    { title: 'QA',                  detail: 'qa-explorer 単独探索 → 3観点並列評価' },
    { title: 'CollectReviewAssets', detail: 'E2E/QA 動画と Playwright HTML レポートを review/ に集約' },
    { title: 'FixLoop',             detail: 'Critical/Major を修正 → supervisor 判定 → stop-judge 判定（最大 max_attempts 巡 or supervisor が halt）' },
    { title: 'Finalize',            detail: 'PR 作成・Release Assets アップロード・review-index 生成' },
  ],
}

// ───────────────────────────────────────────────────────────────────────────
// 引数のデフォルト処理
// ───────────────────────────────────────────────────────────────────────────
// 現行ハーネスは args を JSON-encoded string として注入する不具合があるため、
// string で来たら JSON.parse、object なら素通しの防御パースを行う。
// ハーネスが将来仕様通り object 注入に修正されても両対応で動く。
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const REPORT_ONLY = A.report_only === true
const CREATE_PR = A.create_pr !== false
const MAX_ATTEMPTS = A.max_attempts ?? 5
const MAX_COMMITS = A.max_commits ?? 30
const MAX_TOKEN_PER_ATTEMPT = A.max_token_per_attempt ?? 800_000
const SCOPE_DRIFT_THRESHOLD = A.scope_drift_threshold ?? 0.4
const SUPERVISOR_MODEL = A.supervisor_model
const STOP_JUDGE_MODEL = A.stop_judge_model
const REVIEW_DIR = A.review_dir
const EVIDENCE_DIR = A.evidence_dir
const TASK_ID = A.task_id
const STATE_FILE = `.agent/autopilot/${A.task_id}/state.md`
const INBOX_DIR = `.agent/autopilot/${A.task_id}/inbox/`
// Deviations 常設ログ（Fable Field Guide: Implementation Notes。正常完走時も実装中の逸脱判断を残す）
const NOTES_FILE = `.agent/autopilot/${A.task_id}/implementation-notes.md`

if (!A.requirements_path || !A.design_path || !REVIEW_DIR || !EVIDENCE_DIR || !TASK_ID) {
  throw new Error('build.workflow.js: required args missing (task_id, requirements_path, design_path, review_dir, evidence_dir)')
}

log(`autopilot-build start: task=${TASK_ID} / review_dir=${REVIEW_DIR}${REPORT_ONLY ? ' / report-only (L1)' : ''}`)

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
const PHASE_PLAN_SCHEMA = {
  type: 'object',
  required: ['list', 'rationale'],
  properties: {
    list: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'files', 'depends_on'],
        properties: {
          id: { type: 'string', pattern: '^P[0-9]+$' },
          title: { type: 'string' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string', pattern: '^P[0-9]+$' } },
          test_strategy: { type: 'string', enum: ['unit-only', 'unit+integration', 'unit+e2e'], default: 'unit-only' },
        },
      },
    },
    rationale: { type: 'string' },
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

const E2E_SUITE_SCHEMA = {
  type: 'object',
  required: ['spec_paths', 'user_stories', 'functional'],
  properties: {
    // security spec は「必ず生成」なので下限は1。0本を schema 上正当にすると、
    // 「軽量ケースで user-stories / functional を生成しなかった」と
    // 「生成器が何も作らなかった」が返り値の上で区別できなくなる。
    // （TEST_RESULT 側の同名フィールドには付けない。test-writer 失敗時の
    //   フォールバックが spec_paths: [] を返すため）
    spec_paths: { type: 'array', minItems: 1, items: { type: 'string' } },
    user_stories: {
      type: 'array',
      items: {
        type: 'object',
        required: ['story_id', 'file', 'test_count'],
        properties: {
          story_id: { type: 'string' },
          file: { type: 'string' },
          test_count: { type: 'integer', minimum: 0 },
        },
      },
    },
    functional: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'file', 'test_count'],
        properties: {
          category: { type: 'string' },
          file: { type: 'string' },
          test_count: { type: 'integer', minimum: 0 },
        },
      },
    },
    playwright_config_changes: { type: 'array', items: { type: 'string' } },
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
            'halted-supervisor',
            'halted-commits',
            'halted-token-per-attempt',
            'halted-checkpoint',
            'halted-denylist',
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
  PHASE_PLAN:          PHASE_PLAN_SCHEMA,
  TEST_RESULT:         TEST_RESULT_SCHEMA,
  BUILD_RESULT:        BUILD_RESULT_SCHEMA,
  UNIT_REPORT:         UNIT_REPORT_SCHEMA,
  E2E_SUITE:           E2E_SUITE_SCHEMA,
  QA_EVIDENCE:         QA_EVIDENCE_SCHEMA,
  QA_FINDING:          QA_FINDING_SCHEMA,
  FIX_PLAN:            FIX_PLAN_SCHEMA,
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

// ── Issue #2 P6: baseline SHA と state.md を Plan より前に無条件で初期化 ──
// （FixLoop まで到達せず fatal した場合でも state / inbox の骨格が残るようにする）
let loopBaselineSha = await agent(
  `現在の HEAD コミット SHA を返してください。\`git rev-parse HEAD\` の出力1行のみ。`,
  { label: 'init/loop-baseline-sha' }
)
loopBaselineSha = typeof loopBaselineSha === 'string' ? loopBaselineSha.trim().split(/\s+/)[0] : ''

await agent(
  `${STATE_FILE} に以下の内容で state ファイルを初期化（既存なら append モード）してください。
親ディレクトリが無ければ \`mkdir -p\` で作成。\`${INBOX_DIR}\` も空ディレクトリで作成。

\`\`\`
# autopilot-build state — ${TASK_ID}
- design_path: ${A.design_path}
- max_attempts: ${MAX_ATTEMPTS}
- max_commits: ${MAX_COMMITS}
- max_token_per_attempt: ${MAX_TOKEN_PER_ATTEMPT}
- scope_drift_threshold: ${SCOPE_DRIFT_THRESHOLD}
- loop_baseline_sha: ${loopBaselineSha}

| attempt | commits | tokens | unit_pass | e2e_pass | qa_C | qa_M | verdict | done | reason |
|---|---|---|---|---|---|---|---|---|---|
\`\`\`

また ${NOTES_FILE} も無ければ以下の内容で初期化してください（既存ならそのまま）:

\`\`\`
# implementation notes — ${TASK_ID}

## Deviations（計画からの逸脱・想定外エッジケース対応。1件1行で追記のみ）
| when | phase/item | 逸脱内容 | 理由 |
|---|---|---|---|
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
// Phase 1: Plan — DESIGN.md → Phase 分割
// ───────────────────────────────────────────────────────────────────────────
phase('Plan')
const phasePlan = await schemaAgent(
  `あなたは Phase 分割の専門家です。
REQUIREMENTS.md: ${A.requirements_path}
DESIGN.md: ${A.design_path}

両ファイルを Read し、実装を 10-15 ファイル/Phase の単位に分割してください。
バックエンド層 → API → フロントエンドの依存順を守ること。
PhasePlan schema に従って返してください。`,
  { schema: SCHEMA.PHASE_PLAN, label: 'plan/phase-split' }
)

if (!phasePlan?.list?.length) {
  throw new Error('Plan phase: phasePlan.list is empty')
}
log(`Plan: ${phasePlan.list.length} phases derived`)

// ── L1 report-only: Plan までで停止し、実装・コミットを行わず計画レポートだけ返す ──
if (REPORT_ONLY) {
  const reportPath = `.agent/autopilot/${TASK_ID}/report-only.md`
  await agent(
    `${reportPath} に report-only モード（L1）の実装計画レポートを Markdown で書いてください。
内容:
- Phase 計画（そのまま転載）: ${JSON.stringify(phasePlan.list, null, 2)}
- 各 Phase の変更予定ファイル・依存関係・リスク（DESIGN.md: ${A.design_path} を Read して補足）
- denylist（${denylistPatterns.length} 件: ${denylistPatterns.join(', ') || 'なし'}）に抵触しそうな Phase があれば警告
- 概算コスト見積り: Phase あたり 150k-250k token（test-writer + implementer + unit）+ E2E/QA 100k-200k token + FixLoop 1巡 100k-300k token を目安に合計を出す
- 本実行への案内: 「この計画で問題なければ report_only を外して /auto-build を再実行」
**コード・テストの作成、既存ファイルの変更、コミットは一切行わないこと。**`,
    { label: 'plan/report-only', phase: 'Plan' }
  )
  await agent(
    `${STATE_FILE} の末尾に1行 append してください: \`- report-only run: ${phasePlan.list.length} phases planned（実装なし）\``,
    { label: 'plan/report-only-state', phase: 'Plan' }
  )
  log(`report-only: ${phasePlan.list.length} phases planned — 実装せず終了`)
  return {
    task_id: TASK_ID,
    final_status: 'report-only',
    attempts: 0,
    open_issues: [],
    phase_plan: phasePlan,
    report_path: reportPath,
    commits_used: 0,
    state_file: STATE_FILE,
    inbox_dir: INBOX_DIR,
    loop_baseline_sha: loopBaselineSha,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 2: Build — Phase ごと test-writer → implementer → unit 試走（pipeline）
// ───────────────────────────────────────────────────────────────────────────
phase('Build')
const built = await pipeline(
  phasePlan.list,
  // Stage 1: test-writer（実装を見ず失敗テストを書く）
  (p) => schemaAgent(
    `あなたは test-writer エージェントです。
Phase ${p.id} (${p.title}) の失敗テストを書いてください。
REQUIREMENTS.md / Issue 仕様 のユーザーストーリーを参照。
実装ファイルは絶対に Read しないこと。
テストファイルを作成し、初回試走で全件 FAIL を確認してから test: コミットを作成。
失敗ログは failure_details.message に全文を貼らず、1件あたり 3 行以内に要約すること。
TestResult schema で結果を返してください。`,
    { schema: SCHEMA.TEST_RESULT, agentType: 'dev-flow:test-writer', label: `red/${p.id}`, phase: 'Build' }
  ).catch(err => {
    // Issue #2 P4: test-writer が失敗しても chain を落とさない（implementer は Issue 仕様から書ける）
    log(`⚠ test-writer failed for ${p.id}: ${err.message}`)
    return { status: 'error', passed: 0, failed: 0, total: 0, spec_paths: [] }
  }),
  // Stage 2: implementer（テストを編集せず最小実装）
  (testResult, p) => schemaAgent(
    `あなたは implementer エージェントです。
Phase ${p.id} (${p.title}) の最小実装を書いてください。
直前の test-writer が書いたテスト群 (${(testResult?.spec_paths || []).join(', ')}) を全件 PASS させること。
テスト（spec_paths）が空・欠落している場合は、Issue 仕様と DESIGN.md から直接実装すること。
実装コードは DESIGN.md のディレクトリ構成に従い、実装ソースディレクトリ（src/ 等）に配置すること。
tests/ 配下のヘルパーやモックだけで通すのは禁止（本物の実装を書く）。
テストファイルは絶対に編集しないこと。
画面実装を含む Phase の場合、DESIGN.md §4「claude.ai/design 連携」に URL が記載されていれば必ず参照し、画面ビジュアル（レイアウト・配色・タイポ・コンポーネント構成）はそれを正解として再現すること。URL が「なし」やスキップ理由の場合は §4 のワイヤーフレームを参照する。${DENY_NOTE}
DESIGN.md・Phase 計画から逸脱した判断や想定外のエッジケース対応をした場合は、${NOTES_FILE} の Deviations 表に1行追記してから続行すること（追記のみ・既存行の編集禁止。逸脱が無ければ何も書かない）。
全テスト PASS と lint クリーン（型検査があればそれも）を確認したら feat: コミットを作成。
src_files_created には作成・変更した実装ソースファイルを列挙すること
（設定ファイルのみで完結する Phase（CI/CD 等）はそのファイルパスを入れる）。
BuildResult schema で結果を返してください。`,
    { schema: SCHEMA.BUILD_RESULT, agentType: 'dev-flow:implementer', label: `green/${p.id}`, phase: 'Build' }
  ),
  // Stage 3: ユニット試走と判定（fix-required なら issues_for_fix_loop に積む）
  (buildResult, p) => schemaAgent(
    `あなたはユニットテストランナーです。
Phase ${p.id} のテストを再実行し、lint と合わせて UnitReport schema で返してください。
全 PASS かつ lint クリーンなら decision=proceed、それ以外は decision=fix-required で
issues_for_fix_loop に詳細を入れること。
Phase のテストが1件も存在しない場合は decision=fix-required とし、
issues_for_fix_loop に「Phase ${p.id}: テスト未生成」(severity=Critical) を積むこと。
失敗ログは message に全文を貼らず 3 行以内に要約すること。`,
    { schema: SCHEMA.UNIT_REPORT, label: `unit/${p.id}`, phase: 'Build' }
  ),
)

const buildIssues = built.flatMap(u => u?.issues_for_fix_loop || [])
log(`Build: ${built.filter(Boolean).length}/${phasePlan.list.length} phases done, ${buildIssues.length} fix-required issues`)

// ───────────────────────────────────────────────────────────────────────────
// Phase 3: Integrate — E2E テスト生成と試走
// ───────────────────────────────────────────────────────────────────────────
phase('Integrate')
const e2eSuite = await schemaAgent(
  `あなたは e2e-test-generator エージェントです。
REQUIREMENTS.md と DESIGN.md から E2E spec を生成してください。
**セキュリティテスト（Step 8 → e2e/tests/security/<機能名>-security.spec.ts）は必ず生成すること。**
security spec の生成元は本エージェントだけで、security-tester は実機検証しか担当しないため、
ここで生成しないと security spec は誰にも作られない。
ユーザーストーリーテスト・機能テストは既定では生成しない。次のいずれかに当たるときだけ生成し、
理由を spec 冒頭のコメントに明記すること: (1) コア導線そのものを変更する場合（ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）
(2) pytest / vitest では原理的に検証できない場合（複数画面をまたぐ状態遷移・ブラウザ固有の挙動）。
コア導線の定義・非該当例・迷ったときの倒し方は skills/_shared/reference/core-flow.md にある。
該当しなければ user_stories / functional は空配列で返してよい（それが正常系）。
生成する場合、ユーザーストーリーテストは 1ストーリー = 1 test の一気通貫で書き、
ステップ分割せず test.step() で構造化すること（細かい UI 検証は機能テスト側へ）。
playwright.config.ts に viewport: { width: 1920, height: 1080 } と screenshot: 'on' と video: 'on' が
設定されているかを確認し、未設定なら追記してください（フルHD viewport とreview 用の動画録画が必須）。
E2ESuite schema で目録を返してください。`,
  { schema: SCHEMA.E2E_SUITE, agentType: 'dev-flow:e2e-test-generator', label: 'e2e/generate' }
)

const e2eResult = await schemaAgent(
  `npm run test:e2e を実行し、TestResult schema で結果を返してください。
失敗テストの video.webm パスを failure_details.message に含めること（後段でレビュー動画に集約します）。
エラーログ自体は 3 行以内に要約すること。`,
  { schema: SCHEMA.TEST_RESULT, label: 'e2e/run' }
)

// ───────────────────────────────────────────────────────────────────────────
// Phase 4: QA — qa-explorer 単独 → 3観点並列評価
// ───────────────────────────────────────────────────────────────────────────
phase('QA')
// ── Issue #2 P5: 実装本体が無いまま QA に進むのを防ぐ pre-check gate ──
const srcCheckRaw = await agent(
  `以下の手順で「このループで追加・変更された実装ソースファイル数」を数え、最終行に数字を1つだけ出力してください。
1. \`git diff --name-only ${loopBaselineSha}..HEAD\` で変更ファイル一覧を取得
2. テスト（tests/, __tests__/, *.test.*, *.spec.*, e2e/, playwright/ 配下）と
   設定・ドキュメント（*.config.*, *.json, *.yml, *.yaml, *.md, .github/ 配下）を除いた実装ソースファイルだけを数える
3. その数が 0 の場合のみ、\`git ls-files\` でリポジトリ全体に実装ソースファイルが既に存在するか確認し、
   存在するならその総数を代わりに返す（過去実行分の実装を誤検知しないため）
最終出力は数字1行のみ。`,
  { label: 'qa/precheck-src-exists', phase: 'QA' }
)
const srcFileCount = Number(String(srcCheckRaw ?? '').trim().split(/\s+/).pop())

let qaEvidence
let qaFindings
if (Number.isFinite(srcFileCount) && srcFileCount < 3) {
  log(`⚠ QA precheck failed: 実装ソースファイル数=${srcFileCount}（閾値 3 未満）。QA をスキップし Critical として FixLoop に送る`)
  qaEvidence = { base_dir: '', exploration_log: '', screenshots: [], videos: [], recording_available: false }
  qaFindings = [{
    evaluator: 'qa-technical-evaluator',
    summary: { critical: 1, major: 0, minor: 0 },
    findings: [{
      title: 'QA precheck: 実装本体が未生成（テスト・設定のみ）',
      severity: 'Critical',
      confidence: 100,
      evidence_ref: { log_excerpt: `implementation source files changed = ${srcFileCount}` },
      recommendation: 'DESIGN.md の Phase 計画に従い、実装ソースディレクトリ（src/ 等）に本体コードを実装する',
    }],
  }]
} else {
  qaEvidence = await schemaAgent(
    `あなたは qa-explorer エージェントです。
REQUIREMENTS.md のユーザーストーリーから QA ブリーフを作成し、Playwright MCP で
${A.dev_url} を自律探索してください。
1ゴール1動画で browser_start_video / browser_stop_video を必ず使用。
動画は ${EVIDENCE_DIR}qa/videos/ に保存。
QAEvidence schema で証跡目録を返してください。`,
    { schema: SCHEMA.QA_EVIDENCE, agentType: 'dev-flow:qa-explorer', label: 'qa/explore' }
  )

  qaFindings = await parallel([
    () => schemaAgent(
      `qa-goal-evaluator として ${qaEvidence.base_dir} の証跡を読み、ゴール到達性・導線を評価。
findings に必ず confidence (0-100) を含めること。`,
      { schema: SCHEMA.QA_FINDING, agentType: 'dev-flow:qa-goal-evaluator', label: 'qa/goal', phase: 'QA' }
    ),
    () => schemaAgent(
      `qa-technical-evaluator として ${qaEvidence.base_dir} の証跡から技術エラーを評価。
console / network ログを精査し、findings に confidence を含めること。`,
      { schema: SCHEMA.QA_FINDING, agentType: 'dev-flow:qa-technical-evaluator', label: 'qa/tech', phase: 'QA' }
    ),
    () => schemaAgent(
      `qa-ux-evaluator として ${qaEvidence.base_dir} のスクリーンショットを画像として Read し、UI/UX を評価。
findings に confidence を含めること。`,
      { schema: SCHEMA.QA_FINDING, agentType: 'dev-flow:qa-ux-evaluator', label: 'qa/ux', phase: 'QA' }
    ),
  ])
}

const qaCritical = qaFindings.filter(Boolean).flatMap(f => f.findings).filter(f => f.severity === 'Critical')
const qaMajor    = qaFindings.filter(Boolean).flatMap(f => f.findings).filter(f => f.severity === 'Major')
log(`QA: critical=${qaCritical.length} major=${qaMajor.length} videos=${qaEvidence?.videos?.length ?? 0}`)

// ───────────────────────────────────────────────────────────────────────────
// Phase 5: CollectReviewAssets — 動画・レポート集約
// ───────────────────────────────────────────────────────────────────────────
phase('CollectReviewAssets')
const [e2eVideos, qaVideos] = await parallel([
  () => schemaAgent(
    `e2e/test-results/ 配下の video.webm をすべて ${REVIEW_DIR}videos/e2e/ にコピーし、
VideoIndex schema (source: "e2e") で目録を返してください。`,
    { schema: SCHEMA.VIDEO_INDEX, label: 'collect/e2e', phase: 'CollectReviewAssets' }
  ),
  () => schemaAgent(
    `${EVIDENCE_DIR}qa/videos/ の動画をすべて ${REVIEW_DIR}videos/qa/ にコピーし、
VideoIndex schema (source: "qa") で目録を返してください。録画なし環境では videos=[] でよい。`,
    { schema: SCHEMA.VIDEO_INDEX, label: 'collect/qa', phase: 'CollectReviewAssets' }
  ),
])

// Playwright HTML レポートも集約（npx playwright show-report 用）
await agent(
  `e2e/playwright-report/ があれば ${REVIEW_DIR}playwright-report/ にコピーしてください。
無ければ "skipped" とだけ返してください。`,
  { label: 'collect/playwright-report', phase: 'CollectReviewAssets' }
)

// ───────────────────────────────────────────────────────────────────────────
// Phase 6: FixLoop — Critical/Major を自律修正
// Loop Engineering 適用: 各 attempt 末尾で supervisor / stop-judge / ハードキャップ判定
// ───────────────────────────────────────────────────────────────────────────
phase('FixLoop')
let attempt = 0
// E2E が1本も無い状態は failure_details が空のまま success に見えるため、これを積まないと
// openIssues が空 → FixLoop に一度も入らない → supervisor も stop-judge も起動しない →
// finalStatus='partial-green' のまま PR が作られる（E2E spec 0本・動画0本で）。
// spec が0本のとき Playwright は "No tests found" で exit 1 を返すが、e2e/run が
// それを status だけで報告すると failure_details は空になり、無音で通過する。
const e2eEmpty = e2eResult && Number.isFinite(e2eResult.total) && e2eResult.total === 0
if (e2eEmpty) {
  log('⚠ E2E が0本（total=0）。security spec は必ず生成される契約なので生成器が何も出力していない疑い')
}

let openIssues = [
  ...buildIssues,
  ...qaCritical,
  ...qaMajor,
  ...(e2eEmpty ? [{
    title: 'E2E テストが1本も存在しない（total=0）',
    severity: 'Critical', confidence: 100,
    target: 'e2e/tests/',
    recommendation: 'security spec（e2e-test-generator Step 8）は条件によらず必ず生成される契約。'
      + '0本ということは生成器が何も出力していない。spec の生成からやり直すこと。'
      + 'user-stories / functional を生成しない判断は正常だが、security spec を省く理由にはならない。',
  }] : []),
  ...(e2eResult?.failure_details || []).map((f, i) => ({
    title: `E2E fail: ${f.test_name}`, severity: 'Critical', confidence: 100,
    target: `${f.file || '?'}:${f.line || ''}`,
    recommendation: f.message,
  })),
]
let commitsUsed = 0
let supervisorVerdict = null
let stopJudgeResult = null
let prevUnitPassed = null
let prevE2ePassed = null
let earlyExitStatus = null
// 各 attempt の fixPlan で宣言された files_to_change をループ全体の許容スコープとして monotonic に累積（#4 対策）
const loopDeclaredFiles = new Set()
// denylist 抵触で escalate した修正項目（source_id）の累積
const denylistEscalations = []

while (
  openIssues.length > 0 &&
  attempt < MAX_ATTEMPTS &&
  budget.remaining() > 50_000 &&
  !earlyExitStatus
) {
  attempt++
  const tokenBeforeAttempt = budget.spent()
  log(`FixLoop attempt ${attempt}/${MAX_ATTEMPTS}: ${openIssues.length} open issues, commits_used=${commitsUsed}, budget remaining ${budget.remaining()}`)

  const attemptStartSha = await agent(
    `現在の HEAD コミット SHA を返してください。\`git rev-parse HEAD\` の出力1行のみ。`,
    { label: `fix/attempt-start-sha-${attempt}`, phase: 'FixLoop' }
  )
  const attemptStartShaClean = typeof attemptStartSha === 'string' ? attemptStartSha.trim().split(/\s+/)[0] : ''

  // 修正方針を立てる
  const fixPlan = await schemaAgent(
    `以下の指摘群に対する FixPlan を作ってください。
指摘: ${JSON.stringify(openIssues, null, 2)}
副作用が大きい変更は rollback_strategy を必ず記載。`,
    { schema: SCHEMA.FIX_PLAN, label: `fix/plan-attempt${attempt}`, phase: 'FixLoop' }
  )

  // ── denylist 照合（機械層）: 抵触 item は実行せず inbox へ escalate ──
  if (denylistPatterns.length && fixPlan?.items?.length) {
    const blocked = fixPlan.items.filter(i => (i.files_to_change || []).some(f => denylistHit(f, denylistPatterns)))
    if (blocked.length) {
      fixPlan.items = fixPlan.items.filter(i => !blocked.includes(i))
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
      if (fixPlan.items.length === 0) {
        earlyExitStatus = 'halted-denylist'
        log(`HALT: 全 FixPlan 項目が denylist 抵触。人間判断が必要`)
        break
      }
    }
  }

  // 今 attempt の fixPlan が宣言したファイルを loopDeclaredFiles に累積（monotonic、#4 対策）
  for (const f of fixPlan.items.flatMap(i => i.files_to_change || [])) loopDeclaredFiles.add(f)
  const declaredFilesSet = new Set(loopDeclaredFiles)

  // 修正実行（implementer は sequential、git index.lock 競合を避ける、#9 対策）
  const buildResults = []
  for (const item of fixPlan.items) {
    const r = await schemaAgent(
      `implementer として ${item.source_id} の修正を実行してください。
方針: ${item.approach}
対象: ${item.files_to_change.join(', ')}
テスト更新: ${JSON.stringify(item.test_impact)}
**スコープ厳守**: 上記 files_to_change 以外のファイルは触らないこと。やむを得ず触る場合は理由を notes に必ず記載。${DENY_NOTE}
修正方針（approach）から逸脱した判断や想定外のエッジケース対応をした場合は、${NOTES_FILE} の Deviations 表に1行追記してから続行すること（phase/item 列は "${item.source_id}"。追記のみ・逸脱が無ければ何も書かない）。
実装ロジックの修正は実装ソースディレクトリ（src/ 等）で行い、tests/ 配下のモックで辻褄を合わせるのは禁止。
src_files_created には修正した実装ソースファイルを列挙すること（テスト・設定のみの修正なら空配列でよい）。
全テスト PASS を確認してから fix: コミットを作成。

注意: phase_id フィールドは FixLoop コンテキストでは "${item.source_id}" をそのまま入れて返してください（FB1 / REG1-2 等）。`,
      { schema: SCHEMA.BUILD_RESULT, agentType: 'dev-flow:implementer', label: `fix/run-${item.source_id}`, phase: 'FixLoop' }
    )
    buildResults.push(r)
  }
  // 実 commit 数は diffStats から取得（#2 対策、ここでは集計しない）

  // 再試走（unit + E2E + QA）
  const reRunUnit = await schemaAgent(
    `全ユニットテストと lint を再実行し、UnitReport schema で返してください。
失敗ログは message に全文を貼らず 3 行以内に要約すること。`,
    { schema: SCHEMA.UNIT_REPORT, label: `fix/unit-rerun-${attempt}`, phase: 'FixLoop' }
  )
  const reRunE2E = await schemaAgent(
    `npm run test:e2e を再実行し、TestResult schema で返してください。動画が新たに生成された場合は
${REVIEW_DIR}videos/e2e/ に上書きコピーしてください。
失敗ログは message に 3 行以内で要約すること（動画パスは必ず含める）。`,
    { schema: SCHEMA.TEST_RESULT, label: `fix/e2e-rerun-${attempt}`, phase: 'FixLoop' }
  )

  // QA 再探索（影響範囲のみ）→ 3観点並列評価
  // Major まで消すためには QA 観点の解消も確認する必要がある
  const qaReExplore = await schemaAgent(
    `qa-explorer として今回の修正対象画面を中心に Playwright で再探索してください。
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

  const qaReCritical = qaReFindings.filter(Boolean).flatMap(f => f.findings || []).filter(f => f.severity === 'Critical')
  const qaReMajor    = qaReFindings.filter(Boolean).flatMap(f => f.findings || []).filter(f => f.severity === 'Major')

  const unitPassed = reRunUnit?.test_result?.passed ?? 0
  const e2ePassed  = (reRunE2E?.passed ?? 0)
  // ※ tokensThisAttempt は supervisor/stop-judge/state-append 完了後に再計測（#6 対策）

  // ── (1) attempt の差分統計 ──
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

  // 実 commit 数は diffStats から取得（#2 対策）
  const commitsInAttempt = diffStats?.commits_in_attempt ?? 0
  commitsUsed += commitsInAttempt

  // ── (2) loop-supervisor ──
  supervisorVerdict = await schemaAgent(
    `loop-supervisor として attempt ${attempt} の続行判定を行ってください。

# 元のゴール
- DESIGN.md: ${A.design_path}
- Issue: #${A.issue_number ?? 'N/A'}
- attempt 開始時の openIssues 件数: ${openIssues.length}

# 直前 attempt の差分統計
${JSON.stringify(diffStats, null, 2)}

# 直前 attempt のテスト結果
- unit: passed=${unitPassed} failed=${reRunUnit?.test_result?.failed ?? 0} total=${reRunUnit?.test_result?.total ?? 0}
- e2e: passed=${e2ePassed} failed=${reRunE2E?.failed ?? 0} total=${reRunE2E?.total ?? 0}
- qa: critical=${qaReCritical.length} major=${qaReMajor.length}

# 前 attempt との比較
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

SupervisorVerdict schema に従って verdict / reason / scores を返してください。`,
    {
      schema: SCHEMA.SUPERVISOR_VERDICT,
      agentType: 'dev-flow:loop-supervisor',
      label: `fix/supervisor-${attempt}`,
      phase: 'FixLoop',
      ...(SUPERVISOR_MODEL ? { model: SUPERVISOR_MODEL } : {}),
    }
  )

  // ── (3) stop-judge ──
  stopJudgeResult = await schemaAgent(
    `stop-judge として attempt ${attempt} 終了時点でゴール到達したか判定してください。

# 元のゴール
- DESIGN.md: ${A.design_path}
- Issue: #${A.issue_number ?? 'N/A'}
- attempt 開始時の openIssues 件数: ${openIssues.length}

# 最新テスト結果
- unit: failed=${reRunUnit?.test_result?.failed ?? 0} passed=${unitPassed} total=${reRunUnit?.test_result?.total ?? 0}
- e2e: failed=${reRunE2E?.failed ?? 0} passed=${e2ePassed} total=${reRunE2E?.total ?? 0}
- qa: critical=${qaReCritical.length} major=${qaReMajor.length}

# スコープ宣言
files_to_change[] = ${JSON.stringify([...declaredFilesSet])}

# 直前 attempt の diff 統計
${JSON.stringify(diffStats, null, 2)}

StopJudge schema で done / checks / unmet_goals を返してください。`,
    {
      schema: SCHEMA.STOP_JUDGE,
      agentType: 'dev-flow:stop-judge',
      label: `fix/stop-judge-${attempt}`,
      phase: 'FixLoop',
      ...(STOP_JUDGE_MODEL ? { model: STOP_JUDGE_MODEL } : {}),
    }
  )

  // ── halt 経路でも残課題が表示されるよう openIssues を先に再構築（#5 対策）──
  openIssues = [
    ...(reRunUnit?.issues_for_fix_loop || []).filter(i => i.severity === 'Critical' || i.severity === 'Major'),
    ...(reRunE2E?.failure_details || []).map(f => ({
      title: `E2E fail: ${f.test_name}`, severity: 'Critical', confidence: 100,
      target: `${f.file || '?'}:${f.line || ''}`, recommendation: f.message,
    })),
    ...qaReCritical,
    ...qaReMajor,
  ]

  // tokensThisAttempt はガード agent の消費も含めて再計測（#6 対策）
  const tokensThisAttempt = budget.spent() - tokenBeforeAttempt

  // ── (4) state.md 履歴追記 ──
  await agent(
    `${STATE_FILE} に attempt ${attempt} の行を append してください:
| ${attempt} | ${commitsInAttempt} (累計 ${commitsUsed}) | ${tokensThisAttempt} | ${unitPassed} | ${e2ePassed} | ${qaReCritical.length} | ${qaReMajor.length} | ${supervisorVerdict?.verdict ?? 'unknown'} | ${stopJudgeResult?.done ?? 'unknown'} | ${(supervisorVerdict?.reason ?? '').slice(0, 80).replace(/\|/g, '\\|')} |`,
    { label: `fix/state-append-${attempt}`, phase: 'FixLoop' }
  )

  prevUnitPassed = unitPassed
  prevE2ePassed = e2ePassed

  // ── 判定順序（feedback-fix.workflow.js と同型、#1/#3/#8/#10 対策）──
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
3. 続行する場合は問題箇所を解消してから /auto-build で再開
4. ロールバックする場合は loop_baseline_sha=${loopBaselineSha} に \`git reset\`
\`\`\``,
      { label: `fix/inbox-halt-${attempt}`, phase: 'FixLoop' }
    )
    break
  }

  // 続行: openIssues は既に再構築済み（halt 経路と共通）
}

// 自然終了パスでも stop-judge を最終判定に組み込む（#3 対策）
const naturalAllGreen = openIssues.length === 0 && stopJudgeResult?.done === true
const naturalIncomplete = openIssues.length === 0 && stopJudgeResult && stopJudgeResult.done === false

const finalStatus = earlyExitStatus
  ?? (naturalAllGreen              ? 'all-green' :
      naturalIncomplete            ? 'halted-checkpoint' :
      attempt >= MAX_ATTEMPTS      ? 'halted-attempts' :
      budget.remaining() <= 50_000 ? 'halted-budget' :
                                      'partial-green')

log(`FixLoop done: status=${finalStatus} attempts=${attempt} commits_used=${commitsUsed} remaining_issues=${openIssues.length}`)

// ───────────────────────────────────────────────────────────────────────────
// Phase 7: Finalize — review-index 生成・PR 作成・Release Assets
// ───────────────────────────────────────────────────────────────────────────
phase('Finalize')
const reviewIndex = await schemaAgent(
  `ReviewIndex schema に従い、レビュー用統合インデックスを返してください。
- task_id: ${TASK_ID}
- review_dir: ${REVIEW_DIR}
- 入力:
  - 最終 unit pass rate / e2e pass rate
  - QA Critical/Major 件数
  - 集約された動画 (${(e2eVideos?.videos?.length ?? 0) + (qaVideos?.videos?.length ?? 0)} 本)
- final_status: ${finalStatus}
- total_attempts: ${attempt + 1}
推奨再生速度は QA は 0.5x、E2E は 1.0x がデフォルト。
${REVIEW_DIR}review-video-index.md にも同内容を Markdown で書き出してください。`,
  { schema: SCHEMA.REVIEW_INDEX, label: 'finalize/review-index', phase: 'Finalize' }
)

// 変更理解ドキュメント（explain-diff）生成 — TP3 レビュー前の「理解の速度レギュレーター」
// 失敗しても workflow は止めない（agent 側が "skipped" を返す）
const explainDocRaw = await agent(
  `あなたは explain-diff-generator エージェントです。
今回の自律ビルド（task_id: ${TASK_ID}）のブランチ全体の変更を対象に、変更理解ドキュメントを生成してください。
- 対象 diff: \`git diff origin/main..HEAD\`（空なら "skipped" を返す）
- 文脈: REQUIREMENTS.md / DESIGN.md / 関連 Issue #${A.issue_number ?? '(なし)'} / ${NOTES_FILE}（実装中の逸脱ログ）があれば読むこと
- 出力: 対象リポジトリの .agent/explanations/<今日の日付 YYYY-MM-DD>-<slug>.html（自己完結型 HTML・日本語・4部構成: 背景→直感→コード解説→理解度クイズ5問。ドキュメント保管規約）
- 最終出力は生成した HTML の絶対パスのみ。失敗時は "skipped" とだけ返す。`,
  { agentType: 'dev-flow:explain-diff-generator', label: 'finalize/explain-diff', phase: 'Finalize' }
)
const explainDoc = (typeof explainDocRaw === 'string' && explainDocRaw.trim().startsWith('/'))
  ? explainDocRaw.trim() : null

// PR 作成（gh pr create）と Release アップロードはエージェント経由で実行
// create_pr: false（loop-eval 等）のときはスキップして review-index 生成のみ
const prResult = !CREATE_PR ? null : await agent(
  `PR を作成してください。
- gh pr create の前に必ず実行: REPO_ROOT=$(git rev-parse --show-toplevel); GIT_COMMON=$(git -C "$REPO_ROOT" rev-parse --git-common-dir); case "$GIT_COMMON" in /*) ;; *) GIT_COMMON="$REPO_ROOT/$GIT_COMMON" ;; esac; git -C "$REPO_ROOT" branch --show-current > "$GIT_COMMON/dev-ship-active"
  （dev-flow の pre-pr-guard hook がマーカー無しの gh pr create をブロックするため。auto-build は Finalize で成果物生成済みなので書き込んでよい）
- title: "auto-build: ${TASK_ID}"
- body には以下を必ず含める:
  - Summary（実装した Phase の一覧）
  - 最終ステータス: ${finalStatus} / 試行回数: ${attempt + 1}
  - 動作確認動画セクション（${REVIEW_DIR}review-video-index.md のサマリ）
  - レビュー手順チェックリスト（QA 動画 0.5x 再生推奨など）
  - 計画からの逸脱: ${NOTES_FILE} の Deviations 表を Read し、逸脱があれば「## 計画からの逸脱（Deviations）」セクションとして転載（無ければ「逸脱なし」と1行）
  - Closes #${A.issue_number ?? '(該当 Issue なし)'}
- 動画合計サイズ < 50MB なら .agent/autopilot/${TASK_ID}/review/videos/ を ZIP 化し、
  gh release create で Release Assets に添付して PR 本文からリンクする。
- 50MB 以上なら PR 本文に「動画はローカル ${REVIEW_DIR}videos/ で確認」と注記。
最終的に PR の URL を返してください（テキストでよい）。`,
  { label: 'finalize/pr-create', phase: 'Finalize' }
)

return {
  task_id: TASK_ID,
  final_status: finalStatus,
  attempts: attempt + 1,
  open_issues: openIssues,
  review_index: reviewIndex,
  explain_doc: explainDoc,
  pr_url: typeof prResult === 'string' ? prResult.trim() : null,
  // ── Loop Engineering 由来: halt-* 時に呼び出し側が AskUserQuestion で人間判断を仰ぐための情報 ──
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
- 推奨: /auto-build を再起動する前に FATAL の原因を除去すること
- ロールバック手順: git reset --hard ${loopBaselineSha || '<loop_baseline_sha>'}
\`\`\``,
    { label: 'finalize/fatal-inbox' }
  )
  throw fatalErr
}
