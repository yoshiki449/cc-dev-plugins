---
name: auto-build
description: 確定済み DESIGN.md から実装→ユニットテスト→E2E→QA 自律探索→修正ループを自律完走する。build.workflow.js を起動し、Critical/Major 0件もしくは最大試行回数まで自動でループ。最終的に動画付き PR を作成する。人間との対話はなし（成果物レビューは TP3 で別途）。ユーザーが「自動で全部実装してください」「全部丸投げで作って」「autopilot で実装」「自律ループで作って」「DESIGN.md から自動実装して」「設計書から全部自動で」「自動で完走して」「PR作成まで自動で」のような **完全自動完走への明示的同意** を口にしたら起動する。
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob, Agent, Workflow, gh
---

# /auto-build - 自律実装フェーズ

## ⚠ Workflow ツール起動への同意

**このスキルを起動すること = Workflow ツール（Dynamic Workflows）の起動同意**とみなす。

Workflow は最大 16 並列・1000 エージェント・複数フェーズを自動完走する大規模機構で、トークンコストが大きい。途中でユーザー対話はできない（完走後にサマリのみ返る）。よって以下を起動前に確認する:

1. `DESIGN.md` が確定済みであること
2. ローカル開発環境（DB・サーバー）が起動し、URL とログイン情報が確定していること
3. Playwright MCP が `--caps=devtools` 付きで起動されていること（動画録画必須）

## 概要

`build.workflow.js` を起動し、以下を完走させる:

```
Plan → Build → Integrate → QA → CollectReviewAssets → FixLoop → Finalize
```

- **Plan**: DESIGN.md から Phase 分割
- **Build**: 各 Phase で test-writer → implementer → ユニット試走（pipeline 並列）
- **Integrate**: e2e-test-generator で E2E spec 生成、試走（security spec は常に生成。user-stories / functional は条件付き＝コア導線の変更 or pytest/vitest で検証不能なときだけ。コア導線＝ログイン・決済・申請の承認/却下・権限やテナント境界をまたぐ操作）
  - コア導線の定義・非該当例・迷ったときの倒し方は `skills/_shared/reference/core-flow.md` を読む
- **QA**: qa-explorer で Playwright 自律探索（ブラウザ独占）→ 3観点並列評価
- **CollectReviewAssets**: E2E/QA 動画を `.agent/autopilot/<task>/review/` に集約
- **FixLoop**: Critical/Major を最大 5 巡まで自律修正（毎反復で unit / E2E / QA 再走、`Major 0 件`で all-green）
- **Finalize**: review-video-index.md 生成・PR 作成・Release Assets アップロード

## 手順

### B0. 前提確認

1. `DESIGN.md` 存在確認（`docs/DESIGN.md` 優先 → ルート直下 `./DESIGN.md` フォールバック。REQUIREMENTS.md も同様に解決）
2. 開発環境の起動 URL・テストユーザー認証情報をユーザーから取得（既出ならスキップ）
3. `playwright.config.ts` の `video: 'on'` と `viewport: { width: 1920, height: 1080 }` 設定（無ければ追加）
4. **LOOP.md 読み込み**: `.agent/LOOP.md` があれば「予算（Budget）」セクションの `max_attempts` / `max_commits` を読み、引数未指定の項目の既定値として採用する（優先順: 引数 > LOOP.md > 既定値）。Autonomy Level 表で auto-build が `L1` と宣言されている場合は `report_only: true` で起動する
5. **L1 規律（Never skip L1）**: このプロジェクトで auto-build を初めて実行する場合（`.agent/autopilot/` に完走履歴が無い場合）は、まず `report_only: true` での試走を推奨し、ユーザーに確認する
6. `task_id` を発番: `TASK_ID=$(date +%Y%m%d-%H%M)`
7. `mkdir -p .agent/autopilot/$TASK_ID/review/videos/{e2e,qa} .agent/evidence/$TASK_ID/qa/videos`

### B1. Workflow 起動

```bash
# 概念図（実際は Workflow ツール呼び出し）
Workflow({
  scriptPath: "workflows/build.workflow.js",
  args: {
    task_id: "<TASK_ID>",
    requirements_path: "<repo>/docs/REQUIREMENTS.md",  // B0 で解決した実パス（docs/ 優先 → ルート直下フォールバック）
    design_path: "<repo>/docs/DESIGN.md",              // 同上
    issue_number: <Issue 番号 or null>,
    review_dir: ".agent/autopilot/<TASK_ID>/review/",
    evidence_dir: ".agent/evidence/<TASK_ID>/",
    dev_url: "http://localhost:<port>",
    auth: { email: "...", password: "..." },
    base_branch: "main",
    max_attempts: 5,
    report_only: false,               // true なら Plan までで停止し実装計画レポートのみ（L1 report-only。初回プロジェクトは true 推奨）
    create_pr: true,                  // false なら Finalize の PR 作成・Release アップロードをスキップ（loop-eval 等、リモートの無いリポジトリ向け）
    // ── Loop Engineering 由来の暴走防止ハードキャップ（2026-06-18 事例対策、すべて任意・既定値あり）──
    max_commits: 30,                  // 既定 30。ループ全体の commit 上限（超えたら halted-commits）
    max_token_per_attempt: 800000,    // 既定 800k。1 attempt の token 上限（超えたら halted-token-per-attempt）
    scope_drift_threshold: 0.4,       // 既定 0.4。supervisor が halt-scope-drift と判定する閾値
    supervisor_model: undefined,      // 任意。generator と別モデル推奨（例: 'claude-sonnet-4-6'）
    stop_judge_model: undefined       // 任意。fast model 推奨（例: 'claude-haiku-4-5-20251001'）
  }
})
```

実際の起動は本セッションのメイン Claude が `Workflow` ツールを呼ぶ。

### B2. Workflow 完走待ち

Workflow はバックグラウンドで実行され、完走後にサマリだけ返ってくる。途中状態は `.agent/autopilot/<TASK_ID>/log.md` に追記される。

進行中の確認手段:
- `/workflows` コマンドでライブ進捗を見る（メインセッション側で）
- `tail -f .agent/autopilot/<TASK_ID>/log.md`

### B3. 完走サマリ提示（TP3 への引き継ぎ）

Workflow から返るオブジェクト:
```json
{
  "task_id": "<TASK_ID>",
  "final_status": "all-green | partial-green | report-only | halted-attempts | halted-budget | halted-supervisor | halted-commits | halted-token-per-attempt | halted-checkpoint | halted-denylist",
  "attempts": <試行回数>,
  "open_issues": [...残課題],
  "review_index": {
    "pr_url": "...",
    "videos": [{ "label": "US1: 登録フロー", "category": "qa-goal", "path": "videos/qa/G1.webm", ... }]
  },
  "explain_doc": "<repo>/.agent/explanations/YYYY-MM-DD-<slug>.html | null",
  "supervisor_verdict": { "verdict": "...", "reason": "...", "scores": {...} },
  "stop_judge": { "done": false, "checks": {...}, "unmet_goals": [...] },
  "commits_used": <累積 commits>,
  "state_file": ".agent/autopilot/<TASK_ID>/state.md",
  "inbox_dir": ".agent/autopilot/<TASK_ID>/inbox/",
  "loop_baseline_sha": "<ループ開始時の HEAD SHA>"
}
```

完走後、`.agent/STATE.md` が存在すれば（無ければ `bash skills/_shared/scripts/ensure-loop-files.sh` で生成して）Run Log に1行 append する:
`| <YYYY-MM-DD HH:MM> | auto-build | <normal|report> | <attempts> | <commits_used> | <概算 token（不明なら -）> | <final_status> | <notes> |`
halted-* のときは Open Items にも残課題を1行追記する。

さらに **実行マニフェスト**（dev-hub の実行履歴ビュー用）に成果物を記録する:

```bash
node skills/_shared/scripts/hub-run-add.mjs --repo <repoルート> \
  --run issue-<Issue番号>（Issueなしなら <TASK_ID>） \
  --label "<機能名の短い説明>" --flow auto-build --issue <Issue番号> \
  docs/DESIGN.md docs/REQUIREMENTS.md \
  <explain_doc のパス> \
  .agent/autopilot/<TASK_ID>/review/videos/e2e/*.webm \
  .agent/autopilot/<TASK_ID>/review/videos/qa/*.webm
```

（存在しないファイルは自動スキップ・二重追記なし。同じ Issue の run-id に追記すれば plan → build → ship が1つの実行にまとまる）

ユーザーに以下を提示:
1. **最終ステータス**: all-green なら「PR レビュー可能」、halted なら理由
2. **PR URL**: 動作確認動画リンク付き
3. **動画一覧サマリ**: ゴール／カテゴリ／推奨再生速度
4. **変更理解ドキュメント**: `explain_doc` のパス（背景→直感→コード解説→理解度クイズの4部構成 HTML）。「レビュー前にブラウザで開き、クイズで理解を確認してからレビューに入るのを推奨」と添える（TP3 前の理解の速度レギュレーター）。`null`（生成失敗）なら省略し、`/explain-diff` での手動生成を案内
5. **次のアクション**:
   - 「PR をレビューし、修正したい点があれば `/auto-feedback "<コメント>"` で依頼してください」
   - **report-only の場合**: `report_path` のレポート（Phase 計画・リスク・概算コスト）を提示し、「計画に問題なければ `report_only` を外して再実行してください」と案内（PR・コミットは無い）
   - halted-attempts / halted-budget の場合: 「DESIGN.md を見直して再起動を推奨」
   - **halted-supervisor / halted-commits / halted-token-per-attempt / halted-checkpoint / halted-denylist の場合（後述）**: 必ず `inbox_dir` の申し送り書を読み、`AskUserQuestion` で人間判断を仰ぐ

### B4. halted-* のハンドリング（必須）

`final_status` が `halted-supervisor` / `halted-commits` / `halted-token-per-attempt` / `halted-checkpoint` / `halted-denylist` のいずれかなら、**自動継続せず**必ず以下を実行する（halted-denylist は `attempt-N-denylist.md` も読む）:

1. `inbox_dir` 配下の最新 `attempt-N-halted.md` を Read（supervisor の reason / unexpected_files / unmet_goals が記録されている）
2. `state_file` (state.md) を Read して全 attempt の履歴を把握
3. `AskUserQuestion` で以下4択を提示:
   - **続行（問題箇所を解消してから再起動）**: 推奨。指摘を読み解消して `/auto-build` で再開
   - **ロールバック**: `git reset --hard <loop_baseline_sha>` でループ開始時点に戻す
   - **そのまま PR レビュー**: halted でも作業は残っているので人間レビューに出す（PR は Workflow が既に作成済みの可能性あり）
   - **その他**: 自由記述

「自動で次の attempt を回す」は選択肢に含めない。

## ループ停止条件（優先順）

| 停止種別 | 条件 | 意味 |
|---|---|---|
| `all-green` | stop-judge が done=true | ゴール到達 |
| `halted-attempts` | attempt 数が max_attempts に到達 | 既存 |
| `halted-budget` | グローバル token 残 ≤ 50k | 既存 |
| `halted-commits` | 累積 commits ≥ max_commits | **新**: 暴走防止のコミット上限 |
| `halted-token-per-attempt` | 1 attempt の token ≥ max_token_per_attempt | **新**: 暴走防止の attempt token 上限 |
| `halted-supervisor` | loop-supervisor が halt-scope-drift / halt-regression / halt-thrashing を返した | **新**: 評価者による戦術判定 |
| `halted-checkpoint` | loop-supervisor が escalate-human を返した | **新**: 人間判断要求 |
| `halted-denylist` | 全 FixPlan 項目が denylist（`.agent/loop-denylist.txt`）抵触 | **新**: 手動対応 or denylist 見直し要 |
| `halted-error` | Workflow 内部エラー | 既存 |
| `report-only` | `report_only: true` 指定で Plan 完了 | 停止ではなく L1 の正常終了（実装なし） |

> **Major まで消すために**、FixLoop の各反復で unit / E2E に加えて **QA 再探索（qa-explorer ＋ 3観点並列評価）** も実行する。`feedback-fix.workflow.js` と同構造。QA 1巡で数万トークン消費するため、大規模変更時は `+500k` 等で budget 拡張を推奨。

## Stop（このループが超えてはいけない境界）

Loop Engineering 由来の不変条件。`build.workflow.js` および呼び出し側スキルは以下を遵守する:

- **Never auto-continue past halt**: `final_status` が halt-* のとき、スキル側は **必ず**人間に AskUserQuestion で渡す
- **Never auto-merge**: PR は作るのみ。`gh pr merge` は呼ばない
- **Never delete files outside declared scope**: implementer は `files_to_change[]` 宣言外を削除しない
- **Anything uncertain → inbox**: supervisor / stop-judge の判断不明確箇所は `inbox_dir` に申し送り書を残す
- **Loop baseline tag**: ループ開始時の HEAD は `loop_baseline_sha` として返却し、halted 時のロールバック起点として使う
- **State file is source of truth**: attempt 履歴は `state_file` に追記される

これは「全自動の権利は計測可能な範囲だけ」という原則の実装。2026-06-18 の `feedback-fix` 暴走（6h49min / 101 commits / 12.2M token）の再発防止策。

## Playwright MCP 排他

QA Phase の `qa-explorer` は**ブラウザ単独使用**。Workflow 内で qa-explorer 実行中は他の Playwright 操作を入れない（script レベルで保証）。

## 動画録画と成果物

- E2E: `e2e/test-results/<spec>/video.webm` を `review/videos/e2e/` に集約
- QA: qa-explorer が 1 ゴール 1 動画で `evidence_dir/qa/videos/G<番号>-<説明>.webm` に保存 → `review/videos/qa/` に集約
- 合計 50MB 以下なら ZIP 化して GitHub Release Assets として PR からリンク
- 50MB 超ならローカルパスを PR 本文に明記

## 次フェーズ

- all-green → 人間が PR レビュー → 修正不要なら手動マージ
- 修正希望あり → `/auto-feedback "<自然言語コメント>"` 起動
