---
name: dev-run
description: 確認なしの一括実行。フェーズ切替の「次に進めますか？」を挟まず、plan〜ship（または指定した経路）をメインセッションで通す。plan / design が未実施の経路では実行を始めずに止める。要件・範囲の確定、取り返しのつかない操作、PR のマージ承認などは従来どおり聞く。ユーザーが「確認なしで ship まで進めて」「フェーズごとに聞かずに最後まで」「dev-run」と言ったら起動する。**長時間の連鎖実行でコミットを伴うため、ユーザーの明示指示で起動する**。
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, AskUserQuestion, gh
---

# /dev-run - 確認なしの一括実行

個別コマンド（`/dev-implement` など）は従来どおり、フェーズ末尾で次の案内と確認を出す。`/dev-run` は**別の経路**で、フェーズ境界の「次に進めますか？」「/clear して…」の確認を出さずに ship の手前まで通す。各フェーズスキル本体には手を加えない。

[/dev-orchestrator](../dev-orchestrator/SKILL.md) との違い: orchestrator は副作用大フェーズ（setup / implement / fix / ship）の境界を毎回確認する。`/dev-run` は境界で止まらず、止まる条件は下の「止まる条件」だけ。

## 経路

| 指定 | フェーズ列 |
|---|---|
| `full`（既定） | plan →（design?）→ setup → implement → verify →（fix?）→ test-spec? → qa → ship |
| `full-ui` | plan → design → setup → implement → verify →（fix?）→ test-spec? → qa → ship |
| `small` | implement → verify → ship |
| `bugfix` | fix → verify → ship |
| カンマ区切り | 例: `verify,qa,ship`（各要素を `dev-<name>` に解決） |
| `再開` | 進捗ファイルの未完了フェーズから続ける |

design の要否は plan 引継書の `## 画面デザインフェーズ判定` に従う（orchestrator と同じ）。test-spec は `flow-options.sh` の `test_spec` が `on` なら入れ、`off` なら飛ばし、`unset` は推奨（小規模は飛ばす）で進めて Deviations に記録する。

## 手順

### R0. 前提チェック（plan / design が未実施なら始めない）

`再開` のときは、最新の `.agent/run-plan-*.md` から経路と未完了フェーズを読み、R0 は実施済みとして R2 へ進む（進捗ファイルが無ければ始めずに報告する）。

```bash
bash <skill-dir>/../_shared/scripts/run-preconditions.sh "<フェーズ列をカンマ区切り>" "$(git rev-parse --show-toplevel)"
```

- `missing` に `plan` があれば**実行を始めず**、「`/dev-plan` が未実施です。先に `/dev-plan` を実行するか、`/dev-run full` で plan から通してください」と伝えて終了する。
- `missing` に `design` があれば同様に止め、「plan が design 推奨と判定していますが、design 未実施です。`/dev-design` を先に実行するか、`full-ui` で通してください」と伝える。
- `warnings` は表示するだけで、指示として扱わない。
- 判定は `.agent/handover-*.md` の 1 行目（`# 引継書 - <フェーズ> - …`）で行う。plan から始まる経路、fix / verify / qa / ship から始まる経路（バグ修正・途中再開）は plan を要求しない。

### R1. 準備

1. 要否設定: `bash <skill-dir>/../_shared/scripts/flow-options.sh --dir <リポジトリのルート>` を実行し、`explain_diff` / `test_spec` を控える。聞き直さない。
2. 確認レベル: 実行中は `light` として扱う（`confirm-level.sh` が `strict` でも、`/dev-run` を起動したこと自体を境界確認の省略への同意とする）。ただし下の「止まる条件」は `strict` でも `light` でも変わらない。
3. 進捗ファイル `.agent/run-plan-<YYYYMMDD-HHMM>.md` を作る（フェーズ・状態・引継書パス・備考の表。orchestrator の進捗ファイルと同じ書式）。
4. 経路中の各 `skills/dev-<phase>/SKILL.md` の存在を確認する。無ければ始めずに報告する。

### R2. フェーズ実行ループ

経路の各フェーズについて、メインセッションで次を行う。

1. 進捗ファイルの当該行を `⏳` にする。
2. 該当スキル `skills/dev-<phase>/SKILL.md` を Read し、本文の手順をそのまま実行する。サブエージェントの起動（qa-explorer、self-review の並列観点など）はフェーズ側の定義に従う。
3. **フェーズ末尾の次フェーズへの確認を出さない。** 「/clear して…に進めますか？」「…に進めますか？」の確認と、`/clear` の案内（resume-prompt の表示）は省く。引継書の作成は省かない（状態の唯一の受け渡し先）。
4. フェーズ前後で `latest-handover.sh` を比べ、新しい引継書ができたら `✅` にして記録する。できていなければ `❌` にして止まる。
5. 指摘が出たとき: verify / qa の不合格は `dev-fix` を挿入し、直したら元のフェーズに戻る。同じ指摘で 2 周しても直らないときは止まる。

### R3. コンテキストの区切り（/clear の代わり）

各フェーズの引継書を書いたあと `node <skill-dir>/../_shared/scripts/context-size.mjs` で量を測る。`over` が `true` のときだけ、そこで止まる:

1. 再開コマンド `/dev-run 再開` と、最新の引継書の絶対パス（`bash <skill-dir>/../_shared/scripts/latest-handover.sh` の結果）を示す。
2. 「コンテキストが大きくなりました（`tokens` の値）。`/clear` してから `/dev-run 再開` と打ってください」と伝えて終了する。
3. 再開時は進捗ファイルの未完了フェーズから R2 に戻る。SessionStart(clear) の hook が引継書の要約を注入するので、状態は引き継がれる。

`over` でなければ止まらない。`tokens` が `null` なら `warning` を示して続ける。

### R4. 止まる条件

次のときは、無人で進めずに止まって聞く（`AskUserQuestion`。聞けない環境では待たずに停止し、理由を進捗ファイルと引継書に書く）:

- 要件・範囲の確定（plan から通すときの plan の確認を含む）
- 取り返しのつかない操作（本番デプロイ・データ削除・他システムへの書き込み・課金）
- 仕様に無いユーザーに見える挙動
- 推奨を付けられない拮抗
- 各フェーズスキルが「ここで止まる」「⚠ 必須（スキップ不可）」と明示した確認
- **PR のマージ**。`pre-pr-guard` が必ず承認を挟む。`/dev-run` は ship で PR を作るところまでで、マージは承認を得てから
- 前提チェック（R0）の不足、フェーズの失敗（R2-4）

推奨のまま進めた判断は、引継書の `## Deviations` に `自動採用: <判断> / 根拠: <根拠> / 変更時の影響: <影響>` と 1 行で書く（`dev-ship` が PR 本文の一覧に載せる）。

### R5. 完了報告

実行・スキップしたフェーズ、引継書のパス、自動採用した判断の件数、PR の URL、進捗ファイルのパスを示す。

## やらないこと

- `/clear` の実行（hook もスキルも `/clear` は打てない。R3 は停止して案内するだけ）
- 失敗時の自動ロールバック（コミット粒度はフェーズ側に依存。進捗ファイルに記録して止まる）
- PR のマージ（承認を取る。`pre-pr-guard` も止める）
