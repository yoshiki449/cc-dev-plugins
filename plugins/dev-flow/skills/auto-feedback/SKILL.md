---
name: auto-feedback
description: 成果物レビューで受けた自然言語フィードバックを Workflow（feedback-fix.workflow.js）で構造化→修正→再テスト→再 QA→動画再集約まで自律完走する。`/auto-feedback "<コメント>"` で起動。dev-hub の 📮 ボタンで書き出したレビューコメントは `/auto-feedback --inbox` で取り込む。ユーザーが「フィードバックを反映して」「レビューコメントを自動で直して」「コメントを自動修正して」「レビュー結果を一括で反映」「フィードバックを autopilot で反映」「レビューを自律で反映」「指摘を全部直して再QAまで」「inbox のフィードバックを反映して」「dev-hub のコメントを取り込んで」と言ったら起動する。
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob, Agent, Workflow, gh
---

# /auto-feedback - 成果物フィードバック反映フェーズ

## ⚠ Workflow ツール起動への同意

**このスキルを起動すること = Workflow ツール（Dynamic Workflows）の起動同意**とみなす。

`/auto-build` と同様に Workflow を完走させる。途中でユーザー対話はできない（不明瞭フィードバックは `needs_clarification: true` として完走後に報告）。

## 概要

`/auto-build` 完走後の PR レビューで人間が出した自然言語コメントを受け、`feedback-fix.workflow.js` を起動して以下を完走させる:

```
Interpret → RePlan → FixLoop → CollectReviewAssets → Finalize
```

- **Interpret**: feedback-interpreter で自然言語を FeedbackItems に分解
- **RePlan**: 各項目の FixPlan を立てる
- **FixLoop**: 修正 → 再ユニット → 再 E2E → 再 QA を Critical/Major 0 件まで（最大 3 巡）
- **CollectReviewAssets**: 更新された動画を review/ に再集約
- **Finalize**: review-video-index.md を再生成、PR にコメント追加

## 入力

```bash
/auto-feedback "<自然言語コメント>"       # 従来どおり
/auto-feedback --inbox                    # カレントリポの .agent/feedback-inbox/*.json を全件取り込み
/auto-feedback --inbox <path>             # 特定の inbox エントリだけ取り込み
```

例:
- `/auto-feedback "ログイン後の遷移がもっさり、3秒くらい待たされる。あとパスワード忘れた人向けのリンクが見当たらない"`
- `/auto-feedback "保存ボタンの色が分かりにくい、青にしてほしい。一覧画面の並び順も日付の降順がいい"`
- `/auto-feedback --inbox` — dev-hub の 📮 ボタンで書き出した構造化コメント（quote / 行番号 / 動画 screenshot 付き）を取り込む

複数要望が混在していて構わない（feedback-interpreter が分解する）。

### feedback-inbox（dev-hub 連携）

dev-hub のコメントビューアで「📮 inbox」を押すと、対象プロジェクトの `<リポ>/.agent/feedback-inbox/<item-id>.json` にコメント全量が書き出される（同一成果物は上書き＝1ファイルがその成果物の最新レビュー全量）。スキーマ:

```json
{
  "version": 1, "id": "<item-id>", "type": "video | doc | plan | explanation | report",
  "project": "<プロジェクト名>", "file": "<成果物の絶対パス>", "created_at": "<ISO8601>",
  "comments": [ { "quote": "...", "startLine": 12, "endLine": 20, "comment": "...", "timestamp": 34.5, "screenshot": "<PNG絶対パス>" } ]
}
```

`timestamp`（動画内の秒数）と `screenshot`（フレーム PNG の絶対パス）は動画コメントのみ。

※ Workflow が halt 申し送りを書く `.agent/autopilot/<TASK_ID>/inbox/` とは**別物**なので混同しないこと。

## 手順

### F0. 前提確認

1. `/auto-build` が完走済みで PR が存在することを確認（`gh pr list --head $(git branch --show-current)`）
2. `REQUIREMENTS.md` / `DESIGN.md` が確定済みであること
3. 開発環境が引き続き起動していること
4. 既存 `task_id` を `.agent/autopilot/` 配下から取得（最新ディレクトリ）
5. **LOOP.md 読み込み**: `.agent/LOOP.md` があれば「予算（Budget）」セクションの値を引数未指定項目の既定値として採用（優先順: 引数 > LOOP.md > 既定値）。Autonomy Level 表で auto-feedback が `L1` と宣言されている場合、またはユーザーが「まず計画だけ見たい」と言った場合は `report_only: true` で起動する

### F0.5. `--inbox` のときの取り込み（inbox 指定時のみ）

1. 対象エントリを収集: 引数なしなら `Glob(".agent/feedback-inbox/*.json")`（**直下のみ**。`processed/` は見ない）、`--inbox <path>` ならそのファイルだけ Read
2. **0件なら Workflow を起動せず終了**: 「inbox は空です。dev-hub の 📮 inbox ボタンでコメントを書き出してから再実行してください」と案内する
3. 各エントリを Read し、取り込みサマリ（`file` / `type` / `project` / コメント件数）をユーザーに表示する
4. 全エントリを以下のテンプレで **1つの feedback 文字列に合成**する（この全文が F1 の `feedback` 引数になり、Interpret フェーズで feedback-interpreter にそのまま届く）:

```
以下は dev-hub 成果物レビューで付けられた構造化コメントです。
- file は対象成果物の絶対パス、[L開始-L終了] はソース行番号、quote は指摘箇所の引用です
- [t=秒] は動画内タイムスタンプ、screenshot はその時点のフレーム画像（絶対パス）です
- screenshot がある項目は、必ずそのパスを Read で開いて画面を確認してから解釈してください

### file: <エントリの file> (type: <type>, project: <project>)
1. [L12-L20] quote: "<quote>" → コメント: "<comment>"
2. [t=34.5s] コメント: "<comment>"（screenshot: <screenshot> — Read で確認）
...（エントリごとに ### file: ブロックを繰り返し、コメントは通し番号）
```

- md 系コメント（startLine あり）は `[L<startLine>-L<endLine>]`、startLine が null なら quote のみで表記
- 動画コメントは `[t=<timestamp>s]`＋screenshot パスを必ず含める
- **却下コメントの除外**: コメント本文が `不要:` / `対応不要` / `skip` で始まる項目は**修正対象から除外する**。合成テキストには載せず、「レビュー時に不要と判断された項目」として件数と内容だけをユーザーへの取り込みサマリ（手順3）に表示する。テストケース台帳（🧪）で「この漏れは埋めなくてよい」と記録した行が、そのまま実装指示に回ってしまうのを防ぐ
5. 取り込んだエントリの絶対パス一覧を控えておく（F3 の processed 移動で使う）

### F1. Workflow 起動

```
Workflow({
  scriptPath: "workflows/feedback-fix.workflow.js",
  args: {
    task_id: "<既存 TASK_ID>",
    feedback: "<ユーザーの生コメント（--inbox のときは F0.5 で合成したテキスト）>",
    review_dir: ".agent/autopilot/<TASK_ID>/review/",
    evidence_dir: ".agent/evidence/<TASK_ID>/",
    requirements_path: "<repo>/REQUIREMENTS.md",
    design_path: "<repo>/DESIGN.md",
    dev_url: "http://localhost:<port>",
    issue_number: <Issue 番号 or null>,
    max_attempts: 3,
    report_only: false,               // true なら RePlan までで停止し FixPlan レポートのみ（L1 report-only、修正なし）
    // ── Loop Engineering 由来の暴走防止ハードキャップ（2026-06-18 事例対策、すべて任意・既定値あり）──
    max_commits: 20,                  // 既定 20。ループ全体の commit 上限（超えたら halted-commits）
    max_token_per_attempt: 500000,    // 既定 500k。1 attempt の token 上限（超えたら halted-token-per-attempt）
    scope_drift_threshold: 0.3,       // 既定 0.3。supervisor が halt-scope-drift と判定する閾値
    supervisor_model: undefined,      // 任意。generator と別モデル推奨（例: 'claude-sonnet-4-6'）
    stop_judge_model: undefined       // 任意。fast model 推奨（例: 'claude-haiku-4-5-20251001'）
  }
})
```

### F2. Workflow 完走待ち

`.agent/autopilot/<TASK_ID>/log.md` に追記される進行状況を `tail -f` で確認可能。`/workflows` でライブ進捗も見える。

### F3. 完走サマリ提示

返ってくるオブジェクト:
```json
{
  "task_id": "<TASK_ID>",
  "final_status": "all-green | partial-green | report-only | halted-attempts | halted-budget | halted-supervisor | halted-commits | halted-token-per-attempt | halted-checkpoint | halted-denylist",
  "attempts": <試行回数>,
  "items_consumed": <消化したフィードバック項目数>,
  "items_unclear": [...needs_clarification=true の項目],
  "open_issues": [...回帰や未解決],
  "explain_doc": "<repo>/.agent/explanations/YYYY-MM-DD-<slug>.html | null",
  "supervisor_verdict": { "verdict": "...", "reason": "...", "scores": {...} },
  "stop_judge": { "done": false, "checks": {...}, "unmet_goals": [...] },
  "commits_used": <累積 commits>,
  "state_file": ".agent/autopilot/<TASK_ID>/state.md",
  "inbox_dir": ".agent/autopilot/<TASK_ID>/inbox/",
  "loop_baseline_sha": "<ループ開始時の HEAD SHA>"
}
```

**inbox の consumed 処理（`--inbox` 起動時のみ）**: `final_status` が `halted-error` と `report-only` **以外**なら、取り込んだエントリを `.agent/feedback-inbox/processed/` へ移動する（`mkdir -p .agent/feedback-inbox/processed && mv <取り込んだファイル>... .agent/feedback-inbox/processed/`）。`report-only` は修正していないので**移動しない**（本実行時に再取込みするため）。削除ではなく移動なのは監査性のため。

完走後、`.agent/STATE.md` が存在すれば（無ければ `bash skills/_shared/scripts/ensure-loop-files.sh` で生成して）Run Log に1行 append する:
`| <YYYY-MM-DD HH:MM> | auto-feedback | <normal|report> | <attempts> | <commits_used> | <概算 token（不明なら -）> | <final_status> | <notes> |`
halted-* のときは Open Items にも残課題を1行追記する。

さらに **実行マニフェスト**（dev-hub の実行履歴ビュー用）に成果物を追記する（auto-build と同じ run-id に追記すれば同一実行にまとまる）:

```bash
node skills/_shared/scripts/hub-run-add.mjs --repo <repoルート> \
  --run issue-<Issue番号>（Issueなしなら <TASK_ID>） --flow auto-feedback \
  <explain_doc のパス> \
  .agent/autopilot/<TASK_ID>/review/videos/e2e/*.webm \
  .agent/autopilot/<TASK_ID>/review/videos/qa/*.webm
```

ユーザーに以下を提示:
1. **消化した項目**: 何件のフィードバックを反映したか
2. **不明瞭フィードバック** (`items_unclear`): あれば AskUserQuestion で1件ずつ確認
3. **PR の更新**: 新コメントへのリンク、更新された動画一覧
4. **変更理解ドキュメント**: `explain_doc` のパス（フィードバック反映後のブランチ全体を4部構成 HTML で解説）。「再レビュー前にブラウザで開き、クイズで理解を確認するのを推奨」と添える。`null`（生成失敗）なら省略し、`/explain-diff` での手動生成を案内
5. **次のアクション**:
   - all-green: 「再レビューしてください。問題なければ手動マージ」
   - **report-only**: `report_path` のレポート（FeedbackItems・FixPlan・概算コスト）を提示し、「計画に問題なければ `report_only` を外して再実行してください」と案内（修正・コミットは無い）
   - 不明瞭あり: 「以下の項目は曖昧でした。回答後に再度 `/auto-feedback` してください」
   - 回帰あり: 「`/auto-feedback "回帰のみ修正してほしい"` で追加対応可能」
   - **halted-* （後述）**: 必ず `inbox_dir` の申し送り書を読み、`AskUserQuestion` で人間判断を仰ぐ

### F4. halted-* のハンドリング（必須）

`final_status` が `halted-supervisor` / `halted-commits` / `halted-token-per-attempt` / `halted-checkpoint` / `halted-denylist` のいずれかなら、**自動継続せず**必ず以下を実行する（halted-denylist は `attempt-N-denylist.md` も読む）:

1. `inbox_dir` 配下の最新 `attempt-N-halted.md` を Read（supervisor の reason / unexpected_files / unmet_goals が記録されている）
2. `state_file` (state.md) を Read して全 attempt の履歴を把握
3. `AskUserQuestion` で以下4択を提示:
   - **続行（問題箇所を解消してから再起動）**: 推奨。指摘を読み解消して `/auto-feedback` で再開
   - **ロールバック**: `git reset --hard <loop_baseline_sha>` でループ開始時点に戻す
   - **そのまま PR レビュー**: halted でも作業は残っているので人間レビューに出す
   - **その他**: 自由記述

「自動で次の attempt を回す」は選択肢に含めない。halted = 構造的な歯止め発動を意味するため、人間判断を経ない再起動は禁止。

## ループ停止条件

最大 `max_attempts` 巡（既定 3）に加え、以下のいずれかで早期停止する:

| 停止種別 | 条件 | 意味 |
|---|---|---|
| `all-green` | stop-judge が done=true | ゴール到達。正常完了 |
| `halted-attempts` | attempt 数が max_attempts に到達 | 既存の上限 |
| `halted-budget` | グローバル token 予算残 ≤ 50k | 既存の上限 |
| `halted-commits` | 累積 commits ≥ max_commits | **新**: 暴走防止のコミット上限 |
| `halted-token-per-attempt` | 1 attempt の token ≥ max_token_per_attempt | **新**: 暴走防止の attempt token 上限 |
| `halted-supervisor` | loop-supervisor が halt-scope-drift / halt-regression / halt-thrashing を返した | **新**: 評価者による戦術判定 |
| `halted-checkpoint` | loop-supervisor が escalate-human を返した | **新**: 人間判断要求 |
| `halted-denylist` | 全修正項目が denylist（`.agent/loop-denylist.txt`）抵触 | **新**: 手動対応 or denylist 見直し要 |
| `halted-error` | Workflow 内部エラー | 既存 |
| `report-only` | `report_only: true` 指定で RePlan 完了 | 停止ではなく L1 の正常終了（修正なし） |

## Stop（このループが超えてはいけない境界）

Loop Engineering 由来の不変条件。`feedback-fix.workflow.js` および呼び出し側スキルは以下を遵守する:

- **Never auto-continue past halt**: `final_status` が halt-* のとき、スキル側は **必ず**人間に AskUserQuestion で渡す。続行を勝手に判断しない。
- **Never auto-merge**: PR は作る／コメントするのみ。`gh pr merge` は呼ばない。
- **Never delete files outside declared scope**: implementer は `files_to_change[]` 宣言外のファイルを削除しない。やむを得ず触る場合は `notes` に必ず記載。
- **Anything uncertain → inbox**: supervisor が判断に迷うケース、stop-judge が done=true にできなかった理由は `inbox_dir` に必ず申し送り書を残す。
- **Loop baseline tag**: ループ開始時の HEAD は `loop_baseline_sha` として返却する。halted 時のロールバック起点として使う。
- **State file is source of truth**: attempt 履歴は `state_file` (state.md) に追記される。次 attempt の supervisor はこれを必ず Read する。

これらは「全自動の権利は計測可能な範囲だけ」という原則の実装。2026-06-18 の `feedback-fix` 暴走（6h49min / 101 commits / 12.2M token）の再発防止策。

## 動画録画と再集約

- フィードバック反映後の新世代動画を `review/videos/e2e/` `review/videos/qa/` に**上書きコピー**
- 旧動画を残したい場合は事前に手動でバックアップ
- `review-video-index.md` は再生成（過去版へのリンクは含めない）

## 不明瞭フィードバックの扱い

feedback-interpreter が `needs_clarification: true` と判定した項目は **修正対象から除外**され、完走後の `items_unclear` で報告される。例えば「使いやすくして」は対象画面・期待動作が不明瞭なので AskUserQuestion で人間に問い合わせる。

不明瞭項目への対応:
1. 完走サマリ提示時に AskUserQuestion で1件ずつ質問
2. 回答を踏まえて `/auto-feedback` を再起動

## 次フェーズ

- all-green → 人間が PR 再レビュー → 手動マージ
- さらに修正希望 → 再度 `/auto-feedback`
- 完了 → 手動マージで終了
