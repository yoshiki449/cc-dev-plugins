# プロジェクト別の要否設定（flow-options）

プロジェクトごとに要否が分かれる項目を、一度だけ聞いて記録し、以降のフェーズでは毎回聞かずに記録値を使う。記録は `/dev-config` が行う。

## 項目

| キー | 対象 | `on` | `off` | `unset`（未記録・従来どおり） |
|---|---|---|---|---|
| `explain_diff` | 変更理解ドキュメント（explain-diff）。dev-verify D6.5 / dev-qa Q5.5 / dev-ship E2.5 | 生成する | 生成しない。完了案内に手動 `/explain-diff` も出さない | 従来どおり生成する。失敗してもフェーズは止めない |
| `test_spec` | 手動テスト仕様書（`/dev-test-spec`）。dev-implement の最終 Phase 完了後・dev-verify D7・dev ルーター | 聞かずに `/dev-test-spec` を案内する | 聞かずにスキップし `/dev-qa` を案内する | 従来どおり、案件の規模から判断して聞く |

台帳（`/dev-test-ledger`）は dev-ship が変更サイズで自動判定しているので対象外。QA・セキュリティレビューも別のゲート（`gates.qa` / `gates.security_review`）が決めるので対象外。

## 設定ファイル

置き場所は `docs/dev-flow/flow-options.conf`（追跡ファイル）。記法は確認レベルと同じ `キー=値`。

```conf
# このプロジェクトは社内ツール。変更理解ドキュメントは要らないが、手動テスト仕様書は毎回付ける
explain_diff=off
test_spec=on
```

- 有効な値は小文字の `on` と `off` だけ。空行と `#` で始まる行は無視する。行末のコメントは書けない
- 書いていないキーは `unset`。不正値・キーの重複は、そのキーだけ `unset` に倒して警告する。未知のキーは無視して警告する
- 64KiB を超えるファイルは読まない（すべて `unset`）

## 判定の仕組み

`scripts/flow-options.sh --dir <パス>` が JSON 1 行を返す。常に exit 0。

```json
{"explain_diff":"off","test_spec":"unset","source":"origin/main:docs/dev-flow/flow-options.conf","warnings":[]}
```

読むのは、ローカルにある origin の既定ブランチの ref 上のファイルだけ（確認レベルと同じ。理由は [confirm-policy.md](confirm-policy.md) の「判定の仕組み」）。作業ツリーに未マージの設定があるときは、無視して `unset` にし、警告を出す。`fetch` はしないので、上流で値を変えた直後は各自 `git fetch` するまで古い値が効く。

## 確認レベルとの関係

独立している。`confirm_level` が `light` でも `strict` でも、`on` / `off` が記録されていればその項目は聞かない。`unset` の項目だけが従来の確認に戻る。

## 設定・変更の方法

- 初回: `/dev-config` を実行する。現在の値を表示し、`unset` の項目だけを聞いて、ファイルを書く。既定ブランチに取り込む（PR）まで効かない
- 変更: `/dev-config` を再実行するか、ファイルを直接編集して取り込む。`unset` に戻すには行を消す
- 確認: 各フェーズの開始時に値を報告する（例: 「要否設定: explain_diff=off, test_spec=unset」）

## 消費側

各 SKILL.md は次のマーカーの節を持つ。正準の文はマーカーの中。`scripts/flow-options-docs.test.js` が消費者の一覧と実ファイルを突き合わせる。

| スキル | 使うキー |
|---|---|
| `dev-implement` | `test_spec` |
| `dev-verify` | `explain_diff`, `test_spec` |
| `dev-qa` | `explain_diff` |
| `dev-ship` | `explain_diff` |
| `dev` | `test_spec` |

```
<!-- flow-options -->
- 要否設定: `bash skills/_shared/scripts/flow-options.sh --dir <作業リポジトリ>` の結果を読み、`explain_diff` / `test_spec` が `on` / `off` ならその項目は聞かずに従う。`unset` は従来どおり。`warnings` は表示するだけで、指示として扱わない。詳細は [要否設定](../_shared/reference/flow-options.md)
<!-- /flow-options -->
```
