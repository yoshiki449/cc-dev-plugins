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
（`scripts/secret-scan.sh` 内で除外。大文字小文字は区別しない）：

- `os.environ` / `_require_env` / `process.env` を含む行（コードのenv参照）
- プレースホルダ表記: `<...>`, `your-...`, `replace-with-...`, `example.com`, `placeholder`,
  `fake`, `dummy`, `sample`, `change-me` / `changeme`, `XXXX`, `0000...`, `REDACTED`
- 変数参照: `$VAR`, `${VAR}`
- HTML/JSON: `name="password"`, `description.*password`
- URL / SHA / base64 ヘッダ、`integrity` / `checksum`、`sha(1|256|384|512)-` 接頭辞のSRI形式ハッシュ値そのもの（パターン3のみ。後述の限界あり）

**パターン2の除外判定は「代入された値そのもの」に対してだけ行う（行全体ではない）。**
当初は `grep -viE` で行全体を対象にしていたが、敵対的検証で実機再現された: 値とは
無関係な場所（末尾コメント等）に除外語を1つ混ぜるだけで、本物らしい値の検出を
回避できた（例: `PASSWORD = "aB3xQ9mK2pL7vN4rT8s"  # this is not a sample value`）。
キーワード＋区切り記号の直後から値の文字集合の塊だけを取り出し、除外判定は
その値に対してだけ行う（`HTML/JSON` の2つ、`name="password"` / `description.*password`
は値ではなく行の構造を見るものなので、従来どおり行全体を対象にする）。

さらに、除外語が値の中に**部分文字列として埋め込まれている**ケースも見つかった
（例: `API_TOKEN = "notFakeRealSecretXYZ9"` は値を切り出しても `fake` を含む）。
プレースホルダを示す英単語（fake/dummy/sample/placeholder/redacted/change-me/
your-/replace-with/example.）は、前後を英字で挟まれていない位置でのみ一致させる
（`HASHICORP_TOKEN` を誤って除外しないための `hash` の境界条件と同じ考え方。
`notFakeReal...` の `fake` は前後とも英字に挟まれているため一致しない＝除外されない）。
`xxxx` は単語一致ではなく4文字以上の繰り返し（`x{4,}`）として判定する
（`XXXXXXXX` のような値は先頭の4文字の直後も英字が続くため、単語境界条件だと
一致しなくなってしまうため）。

**パターン3（40文字以上の英数字）の `checksum`/`integrity` 等の除外には、同種の
バイパスが残っている**（`checksum_<実際の値>` のように隣接させて偽装できる）。
パターン2と違って値の範囲を区切る手がかり（キー・区切り記号・クォート）が無いため、
「隣接する語が本物のラベルか偽装か」を区別する必要があり、単純な境界条件では
解けない。パターン3は元から「誤検出多め、要目視」と明記している設計限界の
範囲として残す。
- ハッシュ化済みの値: bcrypt (`$2a$`/`$2b$`/`$2y$`)・argon2・pbkdf2・scrypt の形、
  または変数名に `hash` を含む代入（`PASSWORD_HASH = "..."` 等。値そのものが秘密ではない）。
  `hash` はキーワードと直接隣接する複合語（間はアンダースコア1個まで）に限る。
  `HASHICORP_TOKEN` のように「hash と TOKEN がたまたま同じ行にある」だけでは除外しない
- **SRI形式のハッシュ値（`sha512-<base64>` 等）**: npm/yarn の package-lock.json / yarn.lock の
  `integrity` フィールドはこの形。当初は「`integrity` という語が同じ行にあること」を除外条件に
  していたが、キーと値が別行に分かれた JSON（フォーマッタ等で発生しうる）だと \"integrity\" の
  語が値の行に無くなり誤検出していた（ユーザー報告・実測）。値そのものの形
  （`sha(1|256|384|512)-` 接頭辞）を直接見るようにしたので、キーが同じ行にあるかに依存しない
- **テスト/フィクスチャファイルの追加行**: ファイルパスが `tests?/` `specs?/` `__tests__/`
  `__mocks__/` `mocks?/` `fixtures?/` `__fixtures__/` `testdata/` 配下、または
  `*.test.*` `*.spec.*` `*_test.*` `*_spec.*` に一致するファイル。ダミー値・フィクスチャで
  誤検出しやすいカテゴリなので、この2パターンに限って対象外にする。

  ファイル判定は `git diff --name-only -z`（クォートを一切行わない生のパス一覧を
  NUL 区切りで返す）で別途取得した一覧と、diff 本文中の `diff --git ` 行の
  **出現順**を突き合わせて行う。診断は行わず「ここでファイルが切り替わった」
  ことだけを検知し、対応するパスは信頼できる一覧から引く。

  当初は `diff --git a/<path> b/<path>` の1行からパスをテキストとして正規表現で
  切り出す方式だったが、5回にわたるセキュリティレビューで作っては塞ぐを繰り返した末に
  断念した: ファイル名がスペース・非ASCII文字等の任意の文字を許す以上、区切りを表す
  文字列自体がファイル名の一部として現れうるため、パースの成功/失敗を行の見た目だけから
  正しく判定する方法が原理的に無い（`+++`単体の偽装 → 偽の削除行+追加行の組み合わせでの
  偽装 → リネーム時の新旧パス取り違え → 非ASCIIファイル名のクォートによる抽出失敗 →
  旧パス側に区切り文字列を仕込んだ抽出結果の汚染、と5段階のバイパス経路が実機で見つかった）。
  ファイルパスの中身をテキストから抜き出そうとせず、信頼できる別ソースの一覧を順番で
  引き当てることで、このバイパスのクラスごと閉じた。

  この一覧自体も NUL 区切り（`-z`）から `tr '\0' '\n'` で改行区切りへ単純変換していたが、
  ファイル名に埋め込まれた改行（POSIX 上は許可されている）があるとその場でレコード境界が
  割れ、以降のファイルの対応が1つずつずれるバイパスが実機で見つかった。NUL 区切りのまま
  扱う（バックスラッシュと改行だけをエスケープしてから1行化する）よう直し、レコードの
  境界を実際の改行だけに保った

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

または:

```
export ALLOW_SECRETS=1 && git push origin main
```

このセッション/コマンドだけ secret-guard をスキップ。**使い方を間違えると意味がない**ので、目視確認のうえ使うこと。

**なぜコマンド文字列に書く形で効くのか。** PreToolUse hook（`pre-bash-push-check.sh`）は
`tool_input.command` という**文字列**を受け取って判定するだけで、その文字列を実行するわけでは
ない。hook プロセス自身の環境は Claude Code 本体のプロセスから継承されるだけなので、
これから実行される（まだ実行されていない）コマンド文字列側の代入は、素朴には hook から
見えない（ユーザー報告・実測: `ALLOW_SECRETS=1 git push` と打ってもバイパスされなかった）。
これに対応するため、hook は cd/pushd の移動先をコマンド文字列から拾っているのと同じ考え方で、
`ALLOW_SECRETS=1` / `ALLOW_PUBLISH=1` もコマンド文字列側（`VAR=1 cmd` / `export VAR=1 && cmd`
の形）から読み取る。無関係な変数名（`MY_ALLOW_SECRETS=1` 等）には反応しない。

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
