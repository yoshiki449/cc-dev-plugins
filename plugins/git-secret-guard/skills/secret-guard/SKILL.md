---
name: secret-guard
description: cc-plugins の git-secret-guard 機構の運用ドキュメント。`git push` 直前のシークレット混入スキャンの動作・誤検出時の対処・バイパス方法を案内する。ユーザーが「git push が止まった」「ALLOW_SECRETS って何」「シークレットスキャンを無効化したい」「secret-guard を外したい」などと言ったときに使う。
---

# secret-guard

cc-plugins の **`git-secret-guard`** plugin の挙動と運用をまとめたリファレンススキル。

## 仕組み

```
Claude が Bash("git push origin main") を実行しようとする
       ↓
Claude Code の PreToolUse(Bash) hook が発火
       ↓
hooks/pre-bash-push-check.sh が起動
       ↓
stdin の JSON から tool_input.command を取り出し
       ↓
"git push" を含むか判定
       ↓                                ↓
含まない                             含む
  ↓                                    ↓
exit 0                          scripts/secret-scan.sh を起動
（hook素通り）                        ↓
                              未push 範囲の diff をスキャン
                                     ↓                ↓
                                  検出なし          検出あり
                                     ↓                ↓
                                  exit 0          exit 1（Bash 実行ブロック）
```

**手動 push（北村さんがターミナルで `git push` を叩く）は対象外**。これは設計判断であり、git の側の pre-push hook を入れていない理由でもある。

## 2本目のスキャン: publish-scan

`git push` の直前には **2本**走る。

| スクリプト | 見るもの | バイパス |
|---|---|---|
| `secret-scan.sh` | 秘密の値（トークン prefix・長い英数字・変数代入） | `ALLOW_SECRETS=1` |
| `publish-scan.sh` | 公開してはいけない固有名、実在しそうなメールアドレス、鍵の形 | `ALLOW_PUBLISH=1` |

**`ALLOW_SECRETS=1` は publish-scan を飛ばさない。** 守っている失敗モードが別で、
公開は取り消せないため、秘密スキャンの誤検出回避で巻き添えに無効化してはいけない。

### publish-scan が走る条件

`~/.cc-plugins/publish-denylist.txt` の `[public-repos]` に書いた remote のときだけ走る。
私有リポジトリでは組織固有の語が出てくるのが正常なので、そこでブロックしたら使えない。

判定の権限をこの1ファイルに集めているので、**公開リポジトリ側のファイルを消しても
無効化できない**。denylist 自体をリポジトリ外に置いているのは、中身が
「何を隠したいかの一覧」で、公開リポジトリに入れるとそれ自体が情報になるため。

### denylist の形式

```
[public-repos]
<GitHub の owner/repo>     # remote URL の部分文字列。複数行可

[deny]
<正規表現>                  # grep -E、大文字小文字は区別しない
```

`[deny]` が空なら `exit 2`（走査できないことを「検出なし」と混同しない）。

### 走査対象

- hook 経路: 未 push の追加行。**upstream が無い場合は全コミット**
  （`secret-scan.sh` は直近1コミットだけだが、upstream が無い状況は公開リポジトリへの
  最初の push そのもので、そこで履歴全体が一度に公開される）
- 公開前の一括確認: `bash publish-scan.sh --force --all`

### 走査先リポジトリの決め方

PreToolUse の `cwd` だけに頼らない。`cd /other/repo && git push` のようにコマンド側で
移動している場合、`cwd` のリポジトリを見ても公開対象か判定できない。`cwd` と
コマンド中の `cd` / `pushd` の移動先の**両方**を候補にして、それぞれで走らせる。
publish-scan は remote が公開対象でなければ自分で no-op に落ちるので、候補を増やしても
私有リポジトリでの誤ブロックは起きない。

## スキャン範囲

リポジトリの「未 push の差分」のみ。具体的には以下の優先順で範囲が決まる：

1. `@{push}..HEAD`（push 先 ref が設定されている場合、最も正確）
2. `@{upstream}..HEAD`（upstream はあるが push 先未設定）
3. `HEAD`（新規ブランチ・リモート未設定、ローカル全 commit）

git 全体の history は対象外（速度のため）。

## 検出パターン

| カテゴリ | 例 |
|---|---|
| **SaaS / Cloud トークン** | `sk-...`, `AKIA...`, `ghp_...`, `xox[abp]-...`, `AIza...`, `glpat-...`, PEM形式秘密鍵 |
| **変数代入** | `PASSWORD = "abc123XYZ"`, `API_TOKEN: "..."`, `SECRET = "..."` |
| **長い英数字** | 40文字以上の連続英数字（URL/SHA 等は除外） |

### 誤検出回避（除外条件）

「PASSWORD/API_TOKEN 等の変数代入」「40文字以上の長い英数字」の2パターンは、以下は検出対象外
（`scripts/secret-scan.sh` 内の `grep -viE` で除外。大文字小文字は区別しない）：

- `os.environ` / `_require_env` / `process.env` を含む行（コードのenv参照）
- プレースホルダ表記: `<...>`, `your-...`, `replace-with-...`, `example.com`, `placeholder`,
  `fake`, `dummy`, `sample`, `change-me` / `changeme`, `XXXX`, `0000...`, `REDACTED`
- 変数参照: `$VAR`, `${VAR}`
- HTML/JSON: `name="password"`, `description.*password`
- URL / SHA / base64 ヘッダ、`integrity` / `checksum`
- ハッシュ化済みの値: bcrypt (`$2a$`/`$2b$`/`$2y$`)・argon2・pbkdf2・scrypt の形、
  または変数名に `hash` を含む代入（`PASSWORD_HASH = "..."` 等。値そのものが秘密ではない）。
  `hash` はキーワードと直接隣接する複合語（間はアンダースコア1個まで）に限る。
  `HASHICORP_TOKEN` のように「hash と TOKEN がたまたま同じ行にある」だけでは除外しない
- **テスト/フィクスチャファイルの追加行**: diff のファイルパスが `tests?/` `specs?/` `__tests__/`
  `__mocks__/` `mocks?/` `fixtures?/` `__fixtures__/` `testdata/` 配下、または
  `*.test.*` `*.spec.*` `*_test.*` `*_spec.*` に一致するファイル。ダミー値・フィクスチャで
  誤検出しやすいカテゴリなので、この2パターンに限って対象外にする。ファイル判定は
  diff のファイルヘッダ行 `diff --git a/<path> b/<path>` を追って行う。

  当初は `--- a/<path>` の直後の `+++ b/<path>` を目印にしていたが、これは2段階の
  バイパス経路が実測された: (1) 追加行の中身がたまたま `++ ` から始まると、diff 上は
  `+++ 本文` に見えて偽ヘッダに誤認される。(2) 直前行が `--- ` のときだけ受理する
  よう直しても、削除行の中身が `-- ` から、直後の追加行の中身が `++ ` から始まる
  組み合わせなら「本物のヘッダの並び」自体を模倣できる。`--- `/`+++ ` はどちらも
  削除/追加行の正規のプレフィックス文字（`-`/`+`）と衝突するため、内容側の細工で
  偽装できてしまう。`diff --git ` は unified diff 中で唯一そのどちらのプレフィックスも
  付かない行種別（追加/削除された行は内容がどれだけ似ていても必ず先頭にマーカー文字が
  入る）なので、内容の細工では偽装できない

「既知 SaaS/Cloud トークン prefix」（`sk-`, `AKIA...`, `ghp_...` 等）はテスト/フィクスチャファイルでも
引き続き全文を見る。本物の値がテストファイルに紛れ込む害の方がダミー値の誤検出より大きいため。

それでも誤検出が出た場合は **バイパス**（後述）で対処。

## 検出時の挙動

`git push` が止まり、Claude には以下のようなメッセージが返る：

```
❌ git-secret-guard: 潜在的シークレットを検出しました（range=@{push}..HEAD）

【 SaaS/Cloud トークン形式 】1 件
    +    "api_key": "sk-abc...xyz0",

git push を中止しました。

対処:
  1. 該当の値を ~/.cc-plugins/.env に移動して、コードからは os.environ.get() 等で読む
  2. 誤検出と確信できる場合は ALLOW_SECRETS=1 を環境変数に設定してから再 push
  3. プレースホルダ用の文字列なら <...>, your-..., replace-with-... 等の表記に変える
```

## バイパス手段（緊急時 or 誤検出時）

### A. 環境変数 ALLOW_SECRETS=1

```
ALLOW_SECRETS=1 git push origin main
```

このセッション/コマンドだけ secret-guard をスキップ。**使い方を間違えると意味がない**ので、目視確認のうえ使うこと。

### B. plugin を一時 uninstall

```
/plugin uninstall git-secret-guard@cc-plugins
/reload-plugins
# push 実行
/plugin install git-secret-guard@cc-plugins
/reload-plugins
```

長期間 off にしたい場合のみ。

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| 大量の「40文字以上の長い英数字」検出 | base64 や HTML/CSS 中の長い文字列を誤検出 | パターン側を改善するか、ALLOW_SECRETS=1 でバイパス |
| `git push` が止まらない | hook が登録されていない | `/plugin list` で `git-secret-guard@cc-plugins ✔ enabled` を確認、必要なら `/reload-plugins` |
| 「スキャン対象の差分なし」と出る | 既に push 済みで `@{push}..HEAD` が空 | 正常動作。スキャンするものが無いので素通り |
| Claude 以外の経路で push したい | 手動 `git push` は対象外なので素通り | 設計通り。手動 push は北村さんの責任で実施 |

## ファイル

- `.claude-plugin/plugin.json` — plugin メタデータ
- `hooks/hooks.json` — PreToolUse(Bash) の hook 定義
- `hooks/pre-bash-push-check.sh` — Bash command を判定して scan を起動
- `scripts/secret-scan.sh` — 実際のスキャン処理
- `skills/secret-guard/SKILL.md` — 本ドキュメント
