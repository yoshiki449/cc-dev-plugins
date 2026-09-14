---
name: dev-loop
description: 中規模改修向けの半自律ループ。`dev-implement → dev-self-review → dev-verify` を1コマンドで連鎖し、self-review／verify で指摘が出たら `dev-implement` または `dev-fix` に戻って回す。境界確認は verify 後の1回だけ。`auto-build` より軽く、メインセッション内で逐次実行する。`mode=report` ではコードを変えず指摘レポートだけ出す。ユーザーが「実装～セルフレビュー～動作確認まで一気にループで回して」「一度走らせたら止まらずに implement → review → verify を繰り返して」「auto-build は重すぎるけど自動で回したい」「中規模の改修を自動ループで」「コマンドを毎回打ちたくない」「implement と verify を自動往復させて」と言ったら起動する。「レポートモードで回して」「変更せずに指摘だけ出して」と言ったら mode=report で起動する。**コード変更とコミットを伴うため、ユーザーの明示指示で実行する**。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, gh
---

# /dev-loop - 半自律実装ループ

## このスキルが埋める空白

| スキル | 形態 | コマンド入力回数 | 並列／ガード | 用途 |
|---|---|---|---|---|
| `/dev-implement` ほか個別 | 単発 | 各フェーズ毎に1回 | 各スキルの並列上限 | フェーズ単体で十分なとき |
| **`/dev-loop`（本スキル）** | **逐次ループ** | **1回**で implement↔review↔verify を往復 | 軽量ガード（max_iter / max_commits / thrashing 検知） | **中規模改修・既存機能の小〜中サイズ修正** |
| `/dev-orchestrator` | パイプライン | 1回（毎フェーズ確認） | フェーズ間ユーザー確認 | フル経路を一直線に流したいとき |
| `/auto-build` | Workflow 自律 | 1回（完走後サマリのみ） | loop-supervisor / stop-judge / 16並列 | フル機能・DESIGN.md 確定済・完全自動完走を許容 |

## 起動条件（前提）

1. 既にブランチが切られていて、実装対象（Issue or 修正希望）が確定している
2. `~/.claude/CLAUDE.md` の「3ステップ以上のタスクは Plan モードで開始」ルールは満たしている前提（あらかじめ何を作るか合意済み）
3. ローカル環境が動いていて、`dev-verify` で動作確認できる状態
4. **新規プロジェクト初期化や DESIGN.md 生成が必要な案件には使わない**（その場合は `/dev` ルーターから始める）

## ループの構造

```
[初回 iteration]
  ├─ implement（TDD）
  │
[2回目以降の iteration]
  ├─ 直前の findings 分類 → implement（未実装の新規要件）or fix（バグ・規約・テスト不足）
  │
  ↓
  self-review（3〜5観点並列＝サイズ連動、信頼度80以上フィルタ）
  ├─ Critical/Major あり ──► findings を記録 → 次 iteration（自動で implement or fix に分岐）
  └─ なし ───────────────► verify へ
                            ├─ NG ──► findings を記録 → 次 iteration（自動で implement or fix に分岐）
                            └─ OK ──► AskUserQuestion で人間確認（唯一の停止点）
                                       ├─ 完了 ──► ループ終了 → 次の案内（/dev-ship 等）
                                       ├─ 修正点を追加 ──► 自然言語で修正希望を受け取り fix or implement に分岐 → 次 iteration
                                       └─ 中断 ──► 進捗ファイルに halted 記録、ループ baseline SHA を提示
```

## 停止条件（優先順、上から評価）

| 優先 | 種別 | 条件 | 終了状態 |
|---|---|---|---|
| 1 | `halted-error` | フェーズ実行中の致命的エラー（テスト基盤崩壊・ブランチ消失等）／ 同一 iteration 内で同一フェーズの致命エラーが `max_failed_phase_retries`(=2)回 | 即時異常停止 |
| 2 | `halted-runtime` | ループ全体の経過分 ≥ `max_loop_runtime_minutes`（既定60） | 長時間放置防止 |
| 3 | `halted-commits-per-iter` | 1 iteration 内の commit 数 ≥ `max_commits_per_iter`（既定5） | 単 iter 暴走 |
| 4 | `halted-commits` | baseline 以降の累積 commits ≥ `max_commits` | 累積暴走 |
| 5 | `halted-supervisor` | `loop-supervisor` が `halt-scope-drift` / `halt-regression` / `halt-thrashing` を返した | 意味的暴走（LLM 判定） |
| 6 | `halted-checkpoint` | `loop-supervisor` が `escalate-human` を返した | 人間判断要求 |
| 7 | `halted-thrashing` | 直近2回の findings が `path × normalize(summary)` ハッシュ一致 | 改善が進まないループ（機械的検知） |
| 8 | `halted-iter` | iteration 数 > `max_iterations` | iter 上限 |
| 9 | `halted-user` | ユーザーが「中断」を選択（verify OK 後 or 緊急 AskUserQuestion 中） | ユーザー停止 |
| 10 | `halted-superseded` | 多重起動時に「強制新規開始」が選ばれて旧進捗が無効化 | 多重起動制御 |
| 11 | `done` | verify OK 後に `stop-judge` が done=true を返し、ユーザーが「完了」を選択 | 正常完了 |

すべての halted-* 終了時、ユーザーに以下を提示する:
- 進捗ファイル `.agent/devloop-<TS>.md` のパス
- `loop_baseline_sha`（ループ開始時の HEAD SHA。ロールバックに使う）
- 直前 iteration の findings サマリ
- 次のアクション候補（再開・ロールバック・PR 作成・`/dev-fix` 単発に切替）

## 引数

```
/dev-loop                              # 既定（max_iter=3, max_commits=10, supervisor=on）
/dev-loop max_iter=5                   # 上限拡張
/dev-loop max_iter=5 max_commits=15
/dev-loop mode=report                  # L1 report-only（コード変更ゼロ、指摘レポートのみ）
/dev-loop supervisor=off               # 監視エージェント無効化（機械的ガードのみ）
/dev-loop resume                       # 未完了の進捗ファイルから再開
```

数値の最大値: `max_iter ≤ 10`, `max_commits ≤ 30`。超える指定はユーザーに警告して拒否する。

`supervisor=off` のとき: `loop-supervisor` と `stop-judge` の呼び出しをスキップし、機械的ガード（max_*・ハッシュ thrashing）だけで動く。完全オフラインの軽量モード。

`mode=report` のとき: **L1 report-only モード**（Loop Engineering の autonomy level L1）。implement / fix を一切起動せず、self-review＋verify＋stop-judge を現状コードに対して1巡だけ実行して「ループを回したら何が直されるか」のレポートを出す。コード変更・コミットはゼロ。**初めてのプロジェクト・初めてのパターンでは mode=report から始める**（Never skip L1）。手順は後述「LR. mode=report の実行」。

引数の既定値の優先順は **引数指定 > `.agent/LOOP.md` の予算セクション > 本 SKILL.md の既定**（L0 参照）。

## 手順

### L0. 前提確認と進捗ファイル作成

1. **Pre-flight チェック**（後述「暴走防止ガード § Pre-flight チェック」を実施）
   - `git status --porcelain` で clean tree 確認、dirty なら処理分岐
   - `git symbolic-ref -q HEAD` で detached HEAD 確認
   - 多重起動チェック（既存の `in_progress` 進捗ファイルがあれば AskUserQuestion）
2. **再開チェック**: 引数が `resume` か、未完了ファイルがあれば「最新の loop を再開 / 新規開始 / 中断」を確認
3. **LOOP.md 読み込み**: `.agent/LOOP.md` があれば「予算（Budget）」セクションの `max_iterations` / `max_commits` を読み、**引数未指定の項目の既定値**として採用する（優先順: 引数 > LOOP.md > SKILL.md 既定。上限 `max_iter ≤ 10`, `max_commits ≤ 30` は LOOP.md 値にも適用）。Autonomy Level 表で dev-loop が `L1` と宣言されているのに `mode=report` 以外で起動された場合は、その旨を警告して mode=report を推奨する
4. **引継書取得**: `bash skills/_shared/scripts/latest-handover.sh` で最新引継書を取得し、Issue 番号・対象 Phase・残課題を把握
5. **Issue 番号取得**: `bash skills/_shared/scripts/extract-issue-number.sh`
6. **baseline SHA 記録**: `git rev-parse HEAD` で `loop_baseline_sha` を保存
7. **開始時刻記録**: `date +%s` で `loop_started_at_epoch` を保存（`max_loop_runtime_minutes` 判定に使う）
8. **進捗ファイル作成**: `.agent/devloop-<YYYYMMDD-HHMM>.md`（テンプレートは下記）
9. **TaskCreate** で iteration ごとのタスクを最初に1つだけ作る（実際の TODO は iteration 開始時に随時追加）

`mode=report` のときは 7〜9 の代わりに次節「LR. mode=report の実行」へ進む（進捗ファイルではなくレポートファイルを作る）。

### LR. mode=report の実行（L1 report-only、コード変更ゼロ）

implement / fix は起動せず、以下を**1巡だけ**実行する。**このモードでの Write/Edit はレポートファイル（`.agent/` 配下）のみ許可。ソースコードの変更とコミットは全面禁止**。

1. **self-review 実行**: L1.3 と同じ手順で並列レビュー（3〜5観点・サイズ連動）を現状の HEAD に対して実行
2. **verify 実行**: L1.5 と同じ手順で動作確認・既存 E2E の実行（テストの新規追加はしない。実行のみ）
3. **stop-judge 起動**（`supervisor=on` のとき）: Issue ゴールに対する現状の達成度を判定させる
4. **レポート出力**: `.agent/devloop-<YYYYMMDD-HHMM>-report.md` に以下を書く:
   - findings 一覧（Critical / Major / Minor、信頼度つき）
   - verify 結果（OK / NG と根拠）
   - stop-judge の `checks` / `unmet_goals`
   - 「通常モード（L2）でループを回した場合に修正される見込みの項目」と推定 iteration 数
   - 推奨次アクション（`/dev-loop`（通常モード）／ `/dev-fix` 単発 ／ 対応不要）
5. **STATE.md 追記**: `.agent/STATE.md` が無ければ `bash skills/_shared/scripts/ensure-loop-files.sh` で生成し、Run Log に1行 append（`mode` 列 = `report`、`notes` に findings 件数）
6. **変更ゼロの証明**: `git status --porcelain` が空であることを確認して報告に含める（空でなければ異常。どのステップが書き込んだかを特定して報告する）
7. 終了（final_status: `report-done`）。L1 のループには入らない

進捗ファイルのテンプレート:

```markdown
# /dev-loop 実行記録
開始: YYYY-MM-DD HH:MM
loop_started_at_epoch: <epoch>
Issue: #<番号 or 未確定>
ブランチ: <branch>
loop_baseline_sha: <SHA>
max_iterations: <N>
max_commits: <M>
max_commits_per_iter: 5
max_loop_runtime_minutes: 60

## 設定
- 境界確認: verify 後のみ
- thrashing 検知: 直近2回の findings 正規化ハッシュ一致でhalted
- 監視エージェント: loop-supervisor (1/iter), stop-judge (verify OK 時)  # supervisor=on/off

## Deviations（計画からの逸脱・想定外エッジケース対応。1件1行で追記のみ）
<!-- 例: - [iter 2 / fix] API レスポンス形式を DESIGN と変えた（既存クライアント互換のため） -->

## Iteration ログ

### Iteration 1 — YYYY-MM-DD HH:MM
- フェーズ: implement
- 採用理由: 初回
- 結果: TBD
- commits_delta: 0（iter 内コミット数。max 5）
- commits_cumulative: 0 → ?
- elapsed_minutes: 0
- findings: TBD
- findings_hash: -（thrashing 比較用、normalize(summary) ベース）
- supervisor_verdict: -（continue / halt-* / escalate-human）
- supervisor_reason: -
- stop_judge: -（verify OK iter でのみ。done / confidence / unmet_goals）

<!-- 以降 iteration ごとに追記 -->

## 最終状態
- final_status: in_progress  # done / halted-iter / halted-commits / halted-commits-per-iter / halted-runtime / halted-thrashing / halted-error / halted-user / halted-superseded
- total_iterations: 0
- total_commits: 0
- closed_at: -
- last_findings_hash: -
```

### L1. ループ実行（iteration 単位）

iteration ごとに以下を実施。**iteration 開始時**に進捗ファイルへ新セクションを追記する。

#### L1.1 次フェーズ判定（implement or fix）

- **iteration 1**: 必ず `implement`
- **iteration 2 以降**: 直前 iteration の `findings` を分類:
  - `category = 未実装要件 / 仕様追加 / 新規 Phase` → `implement`
  - `category = バグ / 規約違反 / テスト不足 / 不具合修正 / リファクタ` → `fix`（既定）
  - 分類が曖昧な場合は `fix` を選ぶ（多くの場合適切で、誤判定でも害が少ない）
- **追加点モード**（verify OK 後のユーザー入力経由）: ユーザー入力の自然言語から同様に分類

判定結果と理由を進捗ファイルの当該 iteration セクションに必ず書く。

#### L1.2 implement または fix を実行

該当スキルの SKILL.md を Read し、本文の手順をメイン Claude として実行する。iteration をまたいでも作業範囲は Issue のゴールから広げない（[スコープ規律](../_shared/reference/scope-discipline.md)）:

<!-- scope-discipline -->
- 頼まれた範囲で仕上げる。曖昧な点は注意深い同僚のように解釈し、読み方によって作業が大きく変わるときだけ確認する
- より良い方法があると判断したら一文で伝え、依頼どおりに進める。範囲を黙って広げも狭めもしない
- 終わっていない部分があれば完了と言わず、終えた部分と、残りとその理由を書く
<!-- /scope-discipline -->

- `implement` の場合: `skills/dev-implement/SKILL.md` を Read → TDD サイクル実行
- `fix` の場合: `skills/dev-fix/SKILL.md` を Read → 修正サイクル実行

> ⚠ **dev-loop 経由では Code-Reviewer を Phase 毎に維持する。** dev-implement Step 3 の
> `gates.code_reviewer` が `"ship"`（判定 S・M）を返しても、**dev-loop から実行しているときは
> 実行する**（`per_phase` として扱う）。dev-loop はユーザーの確認を挟まず iteration を回すため、
> 品質観点を ship まで持ち越すと誤りが積み上がった状態でしか止まらない。
> dev-implement Step 0.6 に同じ carve-out が書いてある（両方を同時に直すこと）。
> レンズ本数（`gates.adversarial_lenses`）は dev-loop 経由でも判定どおりに従ってよい。

実行中、Issue・設計・直前 findings の想定から逸脱した判断や想定外のエッジケース対応をした場合は、進捗ファイルの `## Deviations` に1行追記して続行する（追記のみ。逸脱が無ければ書かない）。

実行後（**停止条件は優先順テーブルの順番で評価**）:
1. `commits_delta = git log --oneline <iter_start_sha>..HEAD | wc -l`（当該 iter 内の commit 数）
2. `commits_cumulative = git log --oneline <loop_baseline_sha>..HEAD | wc -l`
3. `elapsed_minutes = ($(date +%s) - loop_started_at_epoch) / 60`
4. 進捗ファイルの当該 iteration セクションに `commits_delta` `commits_cumulative` `elapsed_minutes` を必ず追記
5. 停止条件評価（優先順）:
   - 致命的エラー → `halted-error`
   - `elapsed_minutes ≥ max_loop_runtime_minutes` → `halted-runtime`
   - `commits_delta ≥ max_commits_per_iter` → `halted-commits-per-iter`
   - `commits_cumulative ≥ max_commits` → `halted-commits`
6. いずれかが当たれば L2 へ。当たらなければ L1.3 へ

#### L1.3 self-review を実行

`skills/dev-self-review/SKILL.md` を Read → 並列レビュー実行（起動本数は S1.5 の `gates.self_review_members` が決める＝3〜5本）。

出力: `.agent/self-review/<Issue番号>/integrated-report.md`

集計:
- Critical/Major の数を数える（信頼度80以上のみカウント）
- ゼロなら → L1.5（verify）へ
- 1件以上なら:
  - `findings` を進捗ファイルに記録（path / summary / category）
  - `findings_hash = sort(set( normalize(summary)+'@'+path for f in findings ))` を計算し進捗ファイルへ記録
    - `normalize` = 小文字化＋`:NNN`形式の行番号除去＋連続空白圧縮＋trim
  - **thrashing 判定**: `findings_hash == 直前 iteration の findings_hash` なら `halted-thrashing` で L2 へ
  - **resume 直後の特例**: resume 時、`last_findings_hash` が記録されていて今回のハッシュと一致したら同じく `halted-thrashing`（再暴走防止）
  - そうでなければ次 iteration へ（L1.1 から再開）
  - 次 iteration の予定（implement or fix）も記録

#### L1.4（未使用、L1.3 と L1.5 のあいだに番号を残す）

#### L1.5 verify を実行

`skills/dev-verify/SKILL.md` を Read → 動作確認・E2E 実行。

判定:
- verify レポート（`.agent/verify-*.md` or 引継書）から `OK / NG` を判定
- `NG` の場合:
  - findings を記録（ハッシュ thrashing 判定も実施）
  - **L1.5b（loop-supervisor）** へ
- `OK` の場合:
  - **L1.5b（loop-supervisor）** へ（OK でも意味的暴走を念のためチェック）

#### L1.5b loop-supervisor 起動（`supervisor=on` のとき）

`Agent({ subagent_type: "dev-flow:loop-supervisor", ... })` を起動し、以下を入力として渡す:

- Issue 番号と Issue 本文（ゴール）
- `loop_baseline_sha` 以降の `git diff --stat`
- 今 iteration の self-review findings + verify 結果
- 進捗ファイルの全 iteration ログ
- 前回までの supervisor 判定履歴

`loop-supervisor` の返却 verdict:

| verdict | 動作 |
|---|---|
| `continue` | verify OK なら L1.5c へ／verify NG なら次 iteration（L1.1） |
| `halt-scope-drift` | `halted-supervisor` で L2 へ。reason・unexpected_files を進捗ファイルへ記録 |
| `halt-regression` | `halted-supervisor` で L2 へ |
| `halt-thrashing` | `halted-supervisor` で L2 へ（機械的 thrashing をすり抜けた意味的 thrashing） |
| `escalate-human` | `halted-checkpoint` で L2 へ |

supervisor の verdict は機械的ガード（max_*）と **同じ強度の hard cap として扱う**。verdict=halt-* を AskUserQuestion で覆せない。

#### L1.5c stop-judge 起動（verify OK かつ `supervisor=on` のとき）

`Agent({ subagent_type: "dev-flow:stop-judge", ... })` を起動し、以下を入力として渡す:

- Issue 本文（ゴール）と引継書の「目標一覧」
- 累積差分 + 全 iteration の findings 履歴
- 今回の verify 結果

`stop-judge` の返却:

```json
{
  "done": true | false,
  "checks": { ... 各ゴール項目の達成状況 ... },
  "unmet_goals": [ "..." ],
  "confidence": 0-100
}
```

`stop-judge` の結果を AskUserQuestion の本文に**必ず転載**する:

- `done=true && confidence ≥ 80`: 「stop-judge 完了判定: ✅」→ ユーザー選択肢「完了 / 修正点を追加 / 中断」
- `done=false`: 「stop-judge 完了判定: ⚠ 未達ゴール `[...]`」→ ユーザー選択肢「未達ゴールを修正対象として継続 / 強制完了 / 中断」
  - 「強制完了」を選べる余地は残す（stop-judge の偽陽性も想定して、人間に最終決定権を残す）。ただし強制完了は handover に「stop-judge 反対 / 人間判断で完了」と記録する

#### L1.5d 境界確認 AskUserQuestion

上記 supervisor / stop-judge の結果を踏まえてユーザーに最終確認。

| 選択肢 | 動作 |
|---|---|
| 完了（推奨） | ループ終了 → L2 へ。`done` |
| 修正点を追加 | 自然言語入力を受け取る → category 分類 → 次 iteration（L1.1） |
| 中断 | `halted-user` で L2 へ |

未達ゴール提示時は「未達ゴールを修正対象として継続」を **第一候補** として並べる。

#### L1.6 iteration カウンタ更新と上限チェック

- iteration カウンタ +1
- `elapsed_minutes ≥ max_loop_runtime_minutes` なら `halted-runtime` で L2 へ
- `iteration > max_iterations` なら `halted-iter` で L2 へ
- そうでなければ L1.1 へ

> **Hard cap は途中で緩められない**: ループ内部で AskUserQuestion により「あと1回だけ続けますか」のような上書きは禁止。上限を変えたい場合は halted-* で一度終了させ、次回起動時に引数で渡す。

### L2. ループ終了処理

1. 進捗ファイルの `## 最終状態` セクションを更新（`final_status` / `total_iterations` / `total_commits` / `closed_at`）
2. **halt 妥当性ラベリング**（`final_status` が `halted-supervisor` または `halted-checkpoint` のときのみ）: AskUserQuestion で「この halt は妥当でしたか？」を確認する
   - 選択肢: 「妥当（正しく止めた）」／「過剰（止める必要はなかった）」
   - 回答を STATE.md の Run Log `notes` 列に `halt=妥当` / `halt=過剰` として記録する（loop-supervisor の誤検知率計測用。`.agent/LOOP.md` の見直し基準「誤 halt 率 30% 超」の判定材料になる）
3. **STATE.md 追記**: `.agent/STATE.md` が無ければ `bash skills/_shared/scripts/ensure-loop-files.sh` で生成し、Run Log に1行 append:
   `| <YYYY-MM-DD HH:MM> | dev-loop | <normal|report> | <total_iterations> | <total_commits> | <概算 token（監視エージェント分含む、不明なら -）> | <final_status> | <notes> |`
   `notes` には進捗ファイル `## Deviations` の件数と要約を含める（例: `deviations=2: API形式変更ほか`。0件なら省略可）
   halted-* のときは Open Items にも残課題を1行追記する（`- [YYYY-MM-DD] dev-loop: <直前 findings 要約>（→ /dev-fix or resume）`）
4. 引継書作成（`_shared/reference/handover-template.md` 準拠）。引継書には:
   - 最終 iteration の状態（done / halted-*）
   - 累積 commits 数
   - 直前 findings サマリ
   - 進捗ファイル `## Deviations` の全文（0件なら「逸脱なし」）
   - `loop_baseline_sha` と「ロールバック手順: `git reset --hard <SHA>`」
   - 次のアクション提案
5. **次のアクション案内**（`final_status` 別）:
   - `done`: 「ループ完了。次は `/dev-ship` で PR 作成 or `/dev-qa` で QA を回せます」
   - `halted-iter` / `halted-commits` / `halted-thrashing`: 「自動収束しなかったため、`/dev-fix` で個別対応 or `loop_baseline_sha` にロールバックを検討してください」
   - `halted-user`: 「ユーザー中断。再開は `/dev-loop resume` で可能」
   - `halted-error`: エラー詳細を提示し、人間判断を仰ぐ
6. TaskList の最終クリーンアップ

## 監視エージェント（auto-build の軽量版）

`auto-build` の Workflow が attempt 末尾で呼ぶ `loop-supervisor` / `stop-judge` を **頻度を絞って** メインセッションから直接起動する（Workflow ツールは使わない）。

| エージェント | 起動箇所 | 起動回数 | 役割 |
|---|---|---|---|
| `loop-supervisor` | L1.5b（verify 直後） | 1 / iteration | continue / halt-scope-drift / halt-regression / halt-thrashing / escalate-human の5判定。**機械的ガードでは検知できない意味的暴走**（淡々と仕様から外れていく等）を捕まえる |
| `stop-judge` | L1.5c（verify OK 時のみ） | 1 / loop（最後の verify OK 時のみ） | Issue ゴールに対する達成度判定。`unmet_goals` を AskUserQuestion に転載してユーザーに最終判断材料を渡す。**verify 緑だけで「完了」を選ぶ偽陽性を防ぐ** |

### 機械的ガード vs 監視エージェントの役割分担

| シグナル | 機械的ガード | 監視エージェント |
|---|---|---|
| iteration 回数の暴走 | ✅ `max_iterations` | — |
| commit 量産 | ✅ `max_commits`, `max_commits_per_iter` | — |
| 長時間放置 | ✅ `max_loop_runtime_minutes` | — |
| 文字列一致レベルの同一 findings | ✅ ハッシュ thrashing | — |
| 意味的に同じだが文字列が違う findings | ❌ 検知不能 | ✅ `loop-supervisor` halt-thrashing |
| scope 外への drift（仕様外実装） | ❌ 検知不能（scope-drift 警告は単純な行数指標のみ） | ✅ `loop-supervisor` halt-scope-drift |
| 他テストの破壊（regression） | △ verify 側の失敗で間接検知 | ✅ `loop-supervisor` halt-regression |
| verify 緑だが Issue ゴール未達 | ❌ 検知不能 | ✅ `stop-judge` done=false |

両者は **重ねて** 使う前提（auto-build と同じ思想）。機械的ガードはコスト 0 で必ず効く下限、監視エージェントは意味理解の上限。

### コスト

- `loop-supervisor`: 1 iteration あたり 5〜15k tokens
- `stop-judge`: 1 loop あたり 3〜8k tokens
- 想定オーバーヘッド: 3 iter のループで **約 25〜55k tokens**（`auto-build` の FixLoop と比べて1桁少ない）

cost が気になるとき／オフライン環境では `/dev-loop supervisor=off` で機械的ガードのみのモードへ。

## 暴走防止ガード（Loop Engineering 由来、auto-build の軽量版）

### Pre-flight チェック（L0 で必ず実施）

ループ開始前に以下を確認し、満たさなければ起動拒否する:

1. **working tree が clean** — `git status --porcelain` が空でなければ AskUserQuestion で「commit / stash / 中断」を確認。dirty のまま開始すると `loop_baseline_sha` のロールバックが意図通り動かない
2. **HEAD が detached でない** — `git symbolic-ref -q HEAD` が成功するか確認
3. **対象 Issue／対象 Phase が確定している** — 引継書または引数から確認
4. **多重起動防止**: `.agent/devloop-*.md` で `final_status: in_progress` のファイルが既にあれば「resume / 強制新規開始 / 中断」を確認（強制新規を選ぶときは既存ファイルを `final_status: halted-superseded` に書き換えてから進む）

### Hard cap（無条件停止条件）

これらの条件は **どの選択肢よりも優先**して停止する。途中で「やっぱり1回だけ追加」のような上書きは禁止。

| ガード | しきい値 | 動作 |
|---|---|---|
| **`max_iterations`** | 既定 3, 上限 10 | iteration カウンタが超えた瞬間に `halted-iter` |
| **`max_commits`（累積）** | 既定 10, 上限 30 | ループ baseline 以降の累積 commits が超えたら `halted-commits` |
| **`max_commits_per_iter`** | 既定 5（固定） | **1 iteration 内で5 commit を超えたら即 `halted-commits-per-iter`**。累積上限の前にここで止まることで、1 iter での暴走（例: テスト追加→修正→テスト追加…）を防ぐ |
| **`max_loop_runtime_minutes`** | 既定 60（固定） | ループ全体の経過分が超えたら `halted-runtime`（人間が気づかず放置するリスクを抑制） |
| **`max_failed_phase_retries`** | 既定 2（固定） | 同一 iteration 内で同一フェーズ（例: verify）の致命エラーが2回繰り返したら `halted-error` |

### Soft 検知（過去履歴ベース）

| 検知 | 判定方法 | 動作 |
|---|---|---|
| **thrashing 検知（厳格化）** | 直近2回の findings を `path × normalize(summary)` でハッシュ化して比較。`normalize` = 小文字化＋行番号(`:NNN`)除去＋連続空白圧縮＋先頭末尾 trim。**ハッシュ集合の差分が空** なら thrashing | `halted-thrashing`。**resume 時は直近 thrashing 状態に陥った findings ハッシュを参照し、resume 直後の iteration がそれと同一なら即停止**（resume での再暴走防止） |
| **scope-drift 警告** | iter あたり平均 変更ファイル数 > 5 | 警告のみ。AskUserQuestion で「続行 / 中断」を選ぶ（境界確認の verify OK 後とは別の、緊急問い合わせ） |
| **per-phase timeout** | 個別フェーズ実行が体感30分超 | メイン Claude が「フェーズ進捗が止まっていないか」をユーザーに確認（Bash 等のハング時の安全弁。Claude には自動 kill 権限がないため、人間に escalate する） |

### Stop 不変条件（Loop Engineering 原則の継承）

`auto-build` の Stop 規約と同じ精神で、本スキルも以下を遵守:

- **Never auto-continue past halt**: `halted-*` 状態に入ったら、`/dev-loop resume` の明示再起動でしか続行しない。ループ内部での「もう1回だけ」自動継続は禁止
- **Never auto-merge / Never auto-ship**: PR 作成・マージは本スキルの責務外（`/dev-ship` に明示遷移）
- **Hard cap は上書き不可**: AskUserQuestion で「max_iter を増やしますか」のような選択肢は出さない。上限拡張は **次回起動時の引数** でしか変更できない
- **Supervisor verdict は hard cap と同格**: `loop-supervisor` の `halt-*` / `escalate-human` 判定はユーザー対話で覆さない（強制完了を選べるのは stop-judge の done=false のときのみ）
- **Anything uncertain → handover**: 判断不明な findings は handover に書いて escalate
- **Loop baseline tag**: `loop_baseline_sha` は進捗ファイルと handover の両方に記録。halted 時の最初の提案は常に「ロールバックも選べる」

### 監視可能性

- ループ実行中は **進捗ファイル `.agent/devloop-<TS>.md`** をユーザーが別端末で `tail -f` できる
- 各 iteration の `category 判定 / findings ハッシュ / commits delta / 経過時間` を記録するので、後から「なぜ止まらなかったか」を後追い可能

## このスキルが直接やらないこと

- **QA フェーズ（dev-qa / Playwright MCP 自律探索）** — 重いため別途 `/dev-qa` で
- **PR 作成 / ship** — `/dev-ship` で（ループ完了後）
- **plan / design / setup** — ループの前段で完了している前提
- **DESIGN.md 生成** — `/auto-design` または `/dev-plan` の領域

## 関連スキルとの違い

- **`/dev-orchestrator small`**: パイプライン（implement→verify→ship を 1 巡）。ループしない。フェーズ間で毎回確認。
- **`/auto-build`**: Workflow ツールで完全自律。Playwright MCP 専有・loop-supervisor / stop-judge ゲート付き・DESIGN.md 確定が前提。
- **`/dev-loop`（本スキル）**: メインセッション逐次実行で `implement↔review↔verify` をループ。verify OK 後だけユーザー確認。ship・QA は別途。

## カスタマイズ例

```
/dev-loop                                # 標準（max_iter=3, max_commits=10）
/dev-loop mode=report                    # L1: 変更ゼロで指摘レポートのみ（初めてのプロジェクトはここから）
/dev-loop max_iter=2                     # 短い改修
/dev-loop max_iter=5 max_commits=20      # 中規模改修
/dev-loop resume                         # 中断したループを再開
```
