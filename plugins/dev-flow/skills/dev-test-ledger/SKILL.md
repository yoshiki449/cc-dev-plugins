---
name: dev-test-ledger
description: AI が書いたテストの「漏れ」と「緩さ」を、非エンジニアが1画面で判断できる日本語のテストケース台帳にする。要件にあるのにテストが無いもの、テストはあるが緩いもの、手動でしか確認できないものを分類し、手動テスト仕様書があれば自動にも手動にも無い穴も検出する。ユーザーが「テストケース漏れを確認したい」「テスト台帳を作って」「テストの漏れをレビューしたい」「テストが足りているか見たい」「テストケースのレビューを楽にしたい」「テストが緩くないか確認して」「どのテストが足りない？」と言ったら必ず起動する。
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob, Agent, AskUserQuestion, gh
---

# /dev-test-ledger — テストケース台帳

## リファレンス

- **サブエージェント成果物の受け渡し契約**: [../_shared/reference/subagent-output-contract.md](../_shared/reference/subagent-output-contract.md)

## 何をするスキルか

AI 生成テストのレビューで、人間が本当に判断すべきなのは **「書かれなかったテスト」** だけ。しかし E2E 動画にも、テストコードにも、**書かれなかったテストは映らない**。だから動画を1本ずつ見ても漏れは見つからない。

このスキルは、仕様の側から見た「あるべきテスト」と実際のテストの**差分だけ**を1画面の台帳にする。レビュー対象がテスト全部から漏れ候補（通常3〜5件）に落ちる。

**新しい検査はしない。** 既存の2エージェントが既に出している指摘を、非エンジニアが読める日本語に翻訳して1枚にまとめるだけ。

| 由来 | 検出するもの | 台帳での分類 |
|---|---|---|
| `requirement-coverage-checker` | 要件にあるがテストが無い＋**自動テスト向き** | 🔴 テスト漏れ |
| `requirement-coverage-checker` | 要件にあるがテストが無い＋**手動確認向き**（機械の合否判定が不能） | 🟣 手動テストへ／手動漏れ（下記モード参照） |
| `adversarial-verifier` | テストはあるが緩い・mock 逃避 | 🟠 テストが緩い |
| `requirement-coverage-checker` | 実装そのものが未着手 | ⚪ テスト以前 |
| `requirement-coverage-checker` | 実装・テストとも完了（＋統合モードの手動カバー済み） | ✅ カバー済み（件数のみ） |

自動テスト向き / 手動確認向きの判定は `requirement-coverage-checker` が [../_shared/reference/test-tier-model.md](../_shared/reference/test-tier-model.md)に従って行う。**台帳は機械的に手動送りを決めない**（実際の自動テスト要否は最後に人が判断する、という前提に合わせる）。

## 組織固有の QC 観点（overlay）

dev-flow は組織固有の品質観点を同梱しない。フェーズの開始時に overlay の適用状況を判定する。

```bash
bash <skill-dir>/../_shared/scripts/qc-overlay.sh --phase test-model
```

- `overlay_applied` が `1` → `file` のパスを Read し、並んでいる観点をこのフェーズの追加レンズとして適用する
- `overlay_applied` が `0` → 観点を**自作せずスキップする**（組織の QC を dev-flow が発明してはいけない）

どちらの場合も **適用したかスキップしたかを1行報告する。黙って素通りしない。** `warnings` があれば添える。
判定が `overlay_present` ではなく `overlay_applied` を見ている理由を含む契約は
[../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)。

組織固有の注記（要否をどの会議で決めるか、観点 ID の対応など）は overlay 側にある。
`overlay_applied` が `0` でも振り分け自体は test-tier-model.md で完結するので、台帳は通常どおり作る。

**2つのモード**:
- **seed モード**（手動テスト仕様書がまだ無い）: 手動確認向きは 🟣 手動テストへ（`/dev-test-spec` に起こす候補）。
- **統合モード**（手動テスト計画 JSON `.agent/test-spec-*.json` がある）: 台帳が**手動仕様書とも突き合わせ**、手動仕様書に載っている観点は ✅ 手動カバー済み、載っていない観点は **🟣 手動漏れ（自動にも手動仕様書にも無い真の穴）**として最優先表示する。判定は T2.6 で自動。

## 手順

### T0. Issue 番号の解決と差分チェック

```bash
N=$(bash <skill-dir>/../_shared/scripts/extract-issue-number.sh)
git diff --name-only main...HEAD
```

- Issue 番号が取れない場合は `AskUserQuestion` で番号を尋ねる
- **差分が空なら台帳を作らず終了する**。「実装差分がありません。先に実装してから台帳を作ってください」と伝える（空撃ち防止）

### T1. 前提レポートの確認と自動生成

以下を確認する:
- `.agent/self-review/<N>/coverage.md`
- `.agent/adversarial-review-<N>-phase*-*.md`

**欠けているものだけ**、その場で Agent で生成する（「先に `/dev-self-review` を実行してください」と突き放さない。このスキルの読者は非エンジニア）:

- `coverage.md` が無い → `dev-flow:requirement-coverage-checker` を起動（Issue 番号、差分起点 `main...HEAD`、出力先、および `<skill-dir>/../_shared/reference/test-tier-model.md`（テスト層タグ付けの正）を渡す）
- `adversarial-review-*.md` が無い → `dev-flow:adversarial-verifier` を起動（Issue 番号、`git diff --name-only main...HEAD` のファイル一覧、コミット範囲、出力先を渡す）

両方が既にある場合は何も起動しない（再実行は無駄）。

### T2. テストタイトルの決定的抽出

```bash
node <skill-dir>/../_shared/scripts/extract-test-titles.mjs --repo . --diff main...HEAD > .agent/test-ledger/.titles.json
```

台帳に載せるテスト名を LLM に grep させると転記ミス・幻覚が混ざり、非エンジニアの信頼が壊れる。**必ずこのスクリプトの出力を使う。**

対象0件の場合は stderr に WARNING が出るが exit 0。その場合は「E2E テストがまだ無い」状態なので、台帳では全要件が 🔴 に寄るはず。

### T2.6. 手動テスト仕様書の解決（統合モード判定）

手動テスト計画 JSON があれば、台帳は自動テストだけでなく**手動テスト仕様書との突き合わせ**まで行える（統合モード）。次で対象 Issue の計画 JSON を探す:

```bash
# .agent/test-spec-*.json のうち、overview.issueUrl / docs.requirementUrls が対象 Issue 番号を指すもの
for f in .agent/test-spec-*.json; do
  [ -e "$f" ] || continue
  node -e 'const j=require("./"+process.argv[1]);const n=process.argv[2];const urls=[j.overview&&j.overview.issueUrl,...((j.docs&&j.docs.requirementUrls)||[])].filter(Boolean).join(" ");if(urls.includes("/issues/"+n))console.log(process.argv[1])' "$f" "<N>"
done
```

- **1件見つかった** → そのパスを控える（統合モード）
- **0件** → 手動仕様書はまだ無い（seed モード。従来どおり 🟣＝手動候補）
- **複数** → `AskUserQuestion` で機能名を提示して1つ選ばせる

### T3. 台帳の生成

`dev-flow:test-ledger-writer` エージェントを起動し、以下を渡す。**成果物の受け渡し契約4項目をプロンプトの先頭に置く**（出力先を伝えるだけでは、入力を読み切って書かずに終わる。実測済み）:

<!-- subagent-output-contract:file-output -->
1. 調査に使ってよいツール呼び出しは **N 回まで**（呼び出し側が数値を入れる。**ハーネスのターン上限より小さい値にする**）。N 回に達したら調査を止める
2. 調査が不完全でも、必ず最後に Write ツールで指定パスへ出力する
3. Write が完了してから最終応答を返す。本文返却だけで終えるのは失敗とみなす
4. 指摘が0件なら「0件」と明記したレポートを Write する
<!-- /subagent-output-contract:file-output -->

あわせて次を渡す:
- Issue 番号と Issue タイトル（`gh issue view <N> --json title`）
- `coverage.md` のパス
- `adversarial-review-*.md` のパス群
- `.agent/test-ledger/.titles.json` のパス
- **（統合モードのみ）T2.6 で解決した手動テスト計画 JSON のパス**（無ければ渡さない＝seed モード）

> 統合モードでは、T1 で `requirement-coverage-checker` を起動する際にも同じ手動計画 JSON パスを渡す（checker が §3.6 で手動仕様書と突き合わせ、coverage.md に「手動」列を出す）。**coverage.md が既存（統合前に生成済み）で「手動」列が無い場合は、手動計画 JSON を渡して checker を1回だけ再実行**してから writer に渡す。

出力は `.agent/test-ledger/<N>.md`。

呼び出し側の義務（[契約](../_shared/reference/subagent-output-contract.md)より。文言はそのまま）:

<!-- subagent-output-contract:file-output-checks -->
- **出力確認（スキップ不可）**: 起動した本数分の実体を確認する。「上限に達して停止した」通知も完了として届くので、通知の種類で判断しない
- **再起動するときはプロンプトを差し替える（スキップ不可）**: 同じプロンプトで投げ直せば同じ結果になる。4項目を先頭に置き、残りツール呼び出し回数を明示し、既に得られている指摘を渡す
<!-- /subagent-output-contract:file-output-checks -->

具体的には `test -s .agent/test-ledger/<N>.md` で実体を確認する。書かれていなければ、差し替えの文面は「追加の分析はせず、今わかっている範囲で Write する」にする。

### T4. dev-hub の実行履歴に登録

```bash
node <skill-dir>/../_shared/scripts/hub-run-add.mjs \
  --repo . --run issue-<N> --flow manual --issue <N> \
  .agent/test-ledger/<N>.md
```

### T5. ユーザーへの案内

台帳の 🔴 / 🟣 / 🟠 の件数を伝えたうえで、次を案内する:

1. `/dev-hub` で成果物ハブを開く（🧪 テスト台帳 のチップで絞り込める）
2. 🔴 の表の**足してほしい行**を範囲選択して 💬 でコメント（本文は空でも可）
3. 📮 でインボックスに書き出す
4. `/auto-feedback --inbox` と伝えれば、そのテストが自動で追加される

🟣 の案内はモードで変える:
- **seed モード**（手動仕様書なし）: 「🟣 手動テストへ」の件数を伝え、「これらは自動テストではなく手動テスト仕様書の対象です。`/dev-test-spec` で仕様書に起こせます」と案内（自動では引き継がない。人が起動する）。
- **統合モード**（手動仕様書あり）: 「🟣 手動漏れ（真の穴）」の件数を伝え、「**自動テストにも手動テスト仕様書にも無い**観点です。手動仕様書に追加すべき最優先の漏れです」と強調する。「手動カバー済み」件数も添え、「手動仕様書で拾えているものは確認不要」と伝える。

不要な行は放置してよい。記録を残す場合はコメント本文を `不要:` で始めると、`/auto-feedback` は修正対象から外す。

## 出力先

| ファイル | 内容 |
|---|---|
| `.agent/test-ledger/<Issue番号>.md` | テストケース台帳（dev-hub が 🧪 として表示） |
| `.agent/test-ledger/.titles.json` | テストタイトル抽出の中間データ（台帳の根拠） |

`.agent/` は全面 gitignore（ドキュメント保管規約）。台帳は commit しない。

## このスキルがやらないこと

- **新規の指摘の発見**（`requirement-coverage-checker` と `adversarial-verifier` の責務）
- **テストの追加・修正**（`/auto-feedback --inbox` または `/dev-fix` の責務）
- **手動テスト仕様書の作成**（`/dev-test-spec` の責務。あちらは社外 QC 担当者向けに Google スプレッドシートへ出す。こちらは自動テストの穴を社内レビューするための `.agent/` 配下の作業用台帳）。ただし本スキルは **🟣 手動テストへ の行を dev-test-spec の引き継ぎ候補として提示**する（テスト層モデルで機能テスト＝自動含む／運用・ユーザー視点＝手動、と層が分かれるため。引き継ぎは人が行い、自動プッシュはしない）
- **テストが実際に何かを守っているかの実測**（実装をわざと壊してテストが落ちるか検証する＝ミューテーションテスト。現状は `adversarial-verifier` の静的検出で 🟠 として拾うに留まる）

## 起動元

- ユーザーの明示指示（`/dev-test-ledger`）
- `dev-ship` の E1.5c。**実行位置は `gates.test_ledger` で決まる**:
  `pre_pr`（サイズ L）= PR 作成前 / `post_pr`（S でテスト変更あり・M）= PR 作成後に E2.6 で実行しコメント追記 /
  `skip`（S でテストファイルの変更なし）= 実行しない
