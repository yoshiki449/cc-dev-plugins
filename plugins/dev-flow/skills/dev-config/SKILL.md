---
name: dev-config
description: プロジェクトごとの要否設定。explain-diff と手動テスト仕様書を作るかどうかを一度だけ聞いて docs/dev-flow/flow-options.conf に記録し、以降の dev-flow では毎回聞かない。ユーザーが「要否を設定したい」「explain-diff は要らない」「テスト仕様書の要否を記録して」「毎回聞かれるのをやめたい」「dev-config」と言ったら起動する。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# /dev-config - プロジェクト別の要否設定

仕様は [../_shared/reference/flow-options.md](../_shared/reference/flow-options.md)。

## 手順

### C1. 現在値を読む

```bash
bash skills/_shared/scripts/flow-options.sh --dir "$(git rev-parse --show-toplevel)"
```

`explain_diff` / `test_spec` の値と `warnings` を表示する。`warnings` に「未マージ」があれば、前回の設定が既定ブランチに取り込まれていないと伝える。

### C2. 聞く

`AskUserQuestion` で次を**1回で**聞く。すでに `on` / `off` の項目は、「変更しますか」と一緒に現在値を添える（変更しない選択肢を先頭に置く）。

1. 変更理解ドキュメント（explain-diff）: 「毎回作る（on）」「作らない（off）」
2. 手動テスト仕様書（`/dev-test-spec`）: 「毎回作る（on）」「作らない（off）」「案件ごとに聞く（記録しない）」

質問できない環境（`-p`・無人の `/goal`）では書き込まずに終了し、聞けなかった旨を報告する。

### C3. 書く

`docs/dev-flow/flow-options.conf` を書く（無ければ作る。既存ファイルのコメントと他の行は残す）。「案件ごとに聞く」は行を書かない（既にある行は消す）。書式は `キー=値` の 1 行ずつ。行末コメントは書かない。

### C4. 取り込みを案内する

判定器は origin の既定ブランチの ref 上のファイルだけを読むので、PR で取り込むまで効かない。次を伝える:

1. このファイルを含む PR を作り、既定ブランチへマージする（`/dev-ship` でもよい）
2. マージ後に `git fetch` する
3. 次のフェーズ開始時に「要否設定: …」と報告されることを確認する

変更するときは `/dev-config` を再実行する。
