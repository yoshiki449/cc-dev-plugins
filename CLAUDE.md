# CLAUDE.md — cc-dev-plugins

Claude Code がこのリポジトリで作業するときのガイド。**このリポジトリ固有のルール**だけを置く。

## このリポジトリは何か

Claude Code の **plugin marketplace**（public）。開発フロー系の skills / commands / agents / hooks を
カテゴリ別 plugin として束ね、`/plugin marketplace add` 経由で配布する。

**public リポジトリである。** 組織固有の品質基準・顧客名・社内システム名・業務リポジトリ名・
実在するメールアドレスを書かない。実測の記録（件数・率・事故の因果）は残してよく、
落とすのは「どのリポジトリ・どの顧客か」を指す固有名だけ。

- ✗ `実測（acme-workspace PR #273）では 4,754 行のうち 3,741 行がテストコード`
- ✓ `実測（ある業務リポジトリの PR）では 4,754 行のうち 3,741 行がテストコード`

## ディレクトリ構造

```
cc-dev-plugins/
├── .claude-plugin/marketplace.json   ← カタログ（plugins[] を列挙）
├── README.md
├── CLAUDE.md                          ← このファイル
├── .env.example                       ← ~/.cc-plugins/.env のテンプレート（実値は入れない）
├── docs/testing/                      ← 判定の較正テンプレート（tracked）
└── plugins/
    └── <plugin-name>/
        ├── .claude-plugin/plugin.json
        ├── skills/<skill>/SKILL.md
        ├── commands/<cmd>.md
        ├── agents/
        ├── hooks/hooks.json
        └── scripts/
```

`docs/testing/size-tier.conf.template` の**パスは判定器が固定している**（`assess-change-size.sh` が
この場所を見て「テンプレートがあるのに較正が効いていない」を警告する）。置き場所を変えると
警告経路が死ぬので動かさない。`.agent/` ではなく `docs/` なのは、`.agent/` が全面 gitignore で
worktree ごとに消えるため。記法は dev-flow の `skills/_shared/reference/size-tier-conf.md`。


## plugin 一覧

| plugin | 役割 |
|---|---|
| **dev-flow** | 開発フロー一式（`/dev` ルーター＋フェーズ別スキル＋半自律ループ `dev-loop`＋自律フロー `auto-*`＋成果物ハブ `dev-hub`＋変更理解 `explain-diff`）。詳しい変更履歴は `plugins/dev-flow/.claude-plugin/plugin.json` の description にある |
| **poc-flow** | PoC 専用の軽量フロー。品質ゲートはブラウザ実機スモーク1本のみ。成果物は `.poc/` 配下に置き `.agent/` を作らない（`pre-pr-guard` と `suggest-dev-phase` が `.agent/` の存在をスコープガードにしているため、1回でも作ると PR 作成が恒久ブロックされる） |
| **cc-meta** | この marketplace 自身の管理（`/promote-check` `/promote-skill` `/mark-keep`） |
| **git-secret-guard** | `git push` 直前の走査。秘密の値（`secret-scan.sh`）と公開してはいけない固有名（`publish-scan.sh`）の2本 |

## 編集・運用ルール

### version 規約

- **patch**: バグ修正・ドキュメント更新・誤検出パターン調整
- **minor**: スキル／コマンドの追加・機能拡張（後方互換あり）
- **major**: 破壊的変更（既存スクリプトの引数変更、削除等）

### SKILL.md 内のスクリプトパス参照

絶対パスを書かない。**`<skill-dir>` プレースホルダ**を使う。

```markdown
✅ OK:  python3 <skill-dir>/scripts/foo.py
❌ NG:  python3 /home/<user>/.claude/skills/foo/scripts/foo.py
```

Claude Code は SKILL.md を Read している時点で絶対パスを把握しているので、
`<skill-dir>` を展開して Bash 実行する。

### plugin の外を参照しない

plugin ディレクトリの**外**のファイルは原則参照しない。plugin として配布されると
plugin 単位で隔離されるため、`../` で別 plugin を参照したものは配布先で解決できない。
共通処理は各 plugin に持つか、`scripts/` に重複して置く。

例外は2つだけで、どちらも「ユーザー個別の設定」という枠:

- `~/.cc-plugins/.env` — 環境変数の実値
- `~/.cc-plugins/overlay/` — 組織固有の QC 観点。public な plugin が社内資産を同梱しない
  ための境界。契約は `plugins/dev-flow/skills/_shared/reference/qc-overlay.md`

### agent の起動

`subagent_type` は必ず `<plugin>:<agent>` 形式。接頭辞なしでは名前解決に失敗し、
`~/.claude/agents/` に同名のコピーがある agent は**そちらの旧版**に解決される。

agent の本文で md 出力を指示するなら `tools:` に `Write` を入れる。`Bash` だけを持つと
heredoc で書けてしまい、書けた agent と書けない agent が混在して不安定になる。
「コードは書かない」という制約は `tools` ではなく本文の禁止事項で担保する。

## テスト

```bash
node --test $(git ls-files | grep -E '\.test\.(js|mjs)$' | grep -v '/fixtures/')
```

`fixtures/` を外すのは、あそこに置いてあるのが **vitest 用**のテストで、`node --test` では原理的に読めないため
（`loop-eval` が fixture アプリ上で実走させる。動かすなら fixture ディレクトリで `npm ci` してから vitest で回す）。

機能実装とテストはセット。テストなしのコミットはしない。

**緑だけでは検証にならない。** 「正しいから通った」と「何も検証していないから通った」は
緑では区別できない。守りたい実装をわざと壊してテストが落ちることを実測してから
「テストした」と言う。

**ドキュメントを検査するテストは、挙動を決めている行そのものを固定する。** 語の存在チェックは、
指示を反転しても通る。実測で繰り返し踏んだ失敗なので、正準の1文を HTML コメントのマーカーで
囲み、消費側は byte-identical で持ち、テストはマーカーから読む（テスト側に文字列を転記すると
正準だけ直したときにテストが古いまま通る）。

**代表例の表は allowlist にする。** 「この名前のファイルが無いこと」を検査する denylist 方式は、
別の名前で置かれた瞬間に素通りする。

## 環境ごとの設定（~/.cc-plugins/.env）

plugin のスクリプトは**リポジトリ外のファイルを原則参照しない**。例外は `~/.cc-plugins/.env` と
`~/.cc-plugins/overlay/` の2つだけ。

環境によって変わる値（marketplace リポジトリのパス、試作の置き場）は**手順書に書かず**、
ここから読む。テンプレートは `.env.example`。

| 変数 | 使うところ | 未設定のとき |
|---|---|---|
| `CC_DEV_PLUGINS_DIR` | `/promote-check` `/promote-skill` | exit 2 で止まる。既定値は持たない |
| `CC_PLUGINS_DIR` | 同上 | 同上 |
| `CC_POC_DIR` | `/poc` の scaffold 置き場 | `~/poc` を使う |

**移植先の marketplace に既定値を持たせない**のは、推測で選ぶと業務固有のスキルが
この公開リポジトリへ入る経路になるため。`/promote-skill` は必ず2択を確認する。

## 公開前のゲート

`git push` の直前に `git-secret-guard` の2本が走る。Claude 経由の push だけが対象で、
人が端末から打つ push は素通りする。

**PreToolUse でブロックできる終了コードは 2 だけ。** 0 は通過、2 以外の非ゼロは
stderr をユーザーに見せるだけで**ツール実行は続行する**。この hook は検出時に 1 を返していたため、
v0.1.0 から v0.2.1 まで一度も push を止めていなかった（実測: denylist の語を含むコミットが
公開リポジトリへ通り、偽のトークンを含むコミットも素通りした）。スキャン側の 2 本は単体でも
実行するので 1 のままにして、1 を 2 へ翻訳するのは hook の責務にしている（AC23 で固定）。

絞り込みは hook スクリプトの1箇所だけに置き、登録側（hooks.json）には条件を書かない（AC22）。

**走査先は cwd だけに頼らない。** `cd /repo && git push` はこのリポジトリの worktree 運用の既定形で、
cwd のリポジトリを見ても push される中身とは別物になる。2本のスキャンは同じ候補ループで回し、
片方にだけ候補解決が付いた状態を作らない（AC24）。実際に v0.2.2 まで秘密スキャンだけが cwd 固定で、
偽のトークンを含むコミットが素通りした。

| スクリプト | 見るもの | 止まったときの対処 |
|---|---|---|
| `secret-scan.sh` | 秘密の値（トークン・鍵・長い英数字） | 値を外に出す。誤検出なら `ALLOW_SECRETS=1` |
| `publish-scan.sh` | 公開してはいけない固有名、実在しそうなメールアドレス | 架空の値に置き換える。誤検出なら denylist のパターンを絞る |

`publish-scan.sh` の denylist は `~/.cc-plugins/publish-denylist.txt`（リポジトリ外）にある。
**このリポジトリには置かない** — 中身は「何を隠したいかの一覧」なので、それ自体が情報になる。

`ALLOW_SECRETS=1` は秘密スキャンだけを飛ばす。公開前スキャンは別の失敗モード
（公開してしまったら取り消せない）なので巻き添えで無効化しない。飛ばすには
`ALLOW_PUBLISH=1` を明示する。

公開前に一括で確認するとき:

```bash
bash plugins/git-secret-guard/scripts/publish-scan.sh --force --all
```

**PR を GitHub の画面や API でマージしない。手元から fast-forward で main に push する。**
squash・rebase・マージコミットのどれでも GitHub がコミットを作り直し、アカウントのメールアドレスを入れる
（squash とマージコミットは著者に、rebase は著者を保つがコミッターに入る）。GitHub 上で作られるコミットは
push 前の走査を通らないので、手元のコミットを noreply にしていても公開 main に実在のアドレスが載る
（実測: squash で著者に1件、rebase でコミッターに2件載った。main を書き換えても PR から SHA で参照できる）。

```bash
git fetch origin && git rebase origin/main        # main が進んでいたら先に載せ直す
git push origin HEAD:main                         # fast-forward なので GitHub はコミットを作り直さない
```

push 後に `git log origin/main --format='%h %ae %ce' -5` で著者とコミッターが noreply であることを確かめる。
PR は push で main に取り込まれた時点で GitHub が自動でマージ済みにする。

## やってはいけないこと

1. **秘密の値を直書きしてコミットする**（history に残り、ローテーションが必須になる）
2. **組織固有の固有名を書く**（顧客名・社内システム名・業務リポジトリ名・実在メールアドレス）
3. **`../` で別 plugin を参照する**（配布先で解決できない）
4. **SKILL.md に絶対パスを書く**（`<skill-dir>` を使う）
5. **手動でファイルをコピーして plugin 化する**（`/promote-skill` を使う）
6. **agent を接頭辞なしで起動する**（別の旧版に解決される）
7. **テストを足さずに機能を足す**
