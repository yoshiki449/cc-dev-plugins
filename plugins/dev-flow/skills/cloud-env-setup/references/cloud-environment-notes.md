# クラウド環境設定の注意事項

## クラウドに届くもの・届かないもの

クラウドセッションはリポジトリを毎回新しく clone した VM で動きます。コミットしたものしか届きません。

| もの | 届くか | 手当て |
|---|---|---|
| リポジトリの `CLAUDE.md`・`.claude/rules/`・`.claude/skills/`・`.claude/agents/` | 届く | — |
| リポジトリの `.claude/settings.json` の hook | 届く | — |
| リポジトリの `.claude/settings.json` の plugin 宣言 | **効かない**（ドキュメントでは入るとされるが実測で入らない） | Setup script で `claude plugin install --scope user` する |
| plugin の更新 | `claude plugin install` は「無ければ入れる」だけで、既に入っていると marketplace の最新コミットを追わない。環境のキャッシュを作り直しても、install だけでは古い版のまま止まる | install の直後に `claude plugin marketplace update` と `claude plugin update` も呼ぶ |
| リポジトリの `.mcp.json` | 届く | 対話で承認できないので `enabledMcpjsonServers` で有効化しておく |
| `~/.claude/CLAUDE.md`・`~/.claude/skills/` | 届かない | 必要な部分をリポジトリの `.claude/rules/` などにコミットする |
| ユーザー設定でだけ有効にした plugin | 届かない | Setup script で入れる |
| `claude mcp add` で user / local scope に足した MCP | 届かない | `--scope project` で `.mcp.json` に書いてコミットする |
| `.gitignore` 済みのファイル（`.env` など） | 届かない | `scripts/cloud-session-init.sh` でセッションごとに作る |
| `~/.cc-plugins/overlay/qc/`（組織固有の QC 観点） | 届かない（`$HOME` はセッションごとにリセットされる） | Setup script に埋め込む（`cloud-env-setup` の `scripts/render_qc_overlay_snippet.sh` で生成） |

## Setup script は手動貼り付けが必要

「Setup script」はリポジトリのファイルではなく、claude.ai/code の環境設定ダイアログ内のテキスト欄です。
テンプレートをコピーし、環境作成/編集画面の「Setup script」欄に貼り付けてください
（設定場所: claude.ai/code → メッセージ欄の上の環境名 → 該当環境の設定アイコン）。API/CLI からは書き込めないため、
このスキルが代わりに書き込むことはできません。環境はアカウント単位なので、リポジトリごとに環境を分けると
Setup script を混ぜずに済みます。

## 複数リポジトリのセッション

| 項目 | 実際（2026-09 実測） |
|---|---|
| 作業ディレクトリ | 各リポジトリの親（VM のホームディレクトリ）。`CLAUDE_PROJECT_DIR` は空 |
| CLAUDE.md | 全リポジトリ分が読まれる |
| リポジトリの SessionStart hook・`.mcp.json` | 効かない。仕組みは dev-flow の hook（cloud-stack）に、MCP は Setup script でユーザー単位に置く |
| ユーザー単位の plugin | 効く |
| GitHub API | 付けた全リポジトリに届く |

## ドキュメントと違っていた点（2026-09 実測、claude 2.1.270）

| 項目 | 実際 | 手当て |
|---|---|---|
| plugin | リポジトリの settings.json に宣言しても入らない。SessionStart hook から入れても、そのセッションには間に合わない | Setup script で入れる（テンプレートにある） |
| gh | プリインストールされていない | Setup script で apt から入れる。入らないときは GitHub MCP を使う |
| apt | ベースイメージの PPA が 403 で `apt-get update` が非ゼロ終了する | `&&` でつながず、update の失敗で install を止めない |
| 日本語フォント | 既定の日本語フォントが中国語フォント（WenQuanYi Zen Hei）。`fonts-noto-cjk` を入れても `lang=ja` では中国語フォントが先に選ばれる | `fonts-noto-cjk` を入れ、`/etc/fonts/local.conf` で `lang=ja` のときだけ Noto Sans CJK JP を先頭にする（テンプレートにある） |
| Docker Hub | 既定の許可リストにある `production.cloudflare.docker.com` ではなく `production.cloudfront.docker.com` から配られ、403 で pull できない | Network access を Custom にして足す |
| Docker ビルド | VM はプロキシの自己署名 CA 越しに外へ出るので、ビルドコンテナ内の pip / npm が `CERTIFICATE_VERIFY_FAILED` | `/root/.ccr/ca-bundle.crt` をビルドに渡す（SKILL.md の実行手順3） |
| playwright MCP | セッション内で実行した `claude mcp list` は `.mcp.json` のサーバーを `⏸ Pending approval` と表示するが、セッション本体は承認なしで読み込んでおりツールは使える | 表示ではなく、ツールが実際に使えるかで確かめる |
| playwright MCP と自己署名証明書 | LB を自前で持つリポジトリ（hrms 等）の HTTPS は自己署名証明書で、ローカルの CA を信頼させる手立てが無い。`browser_navigate` が `ERR_CERT_AUTHORITY_INVALID` で失敗する | 登録時に `--ignore-https-errors` を付ける（テンプレートにある） |
| MCP の起動 | セッション開始時に npx がその場でパッケージを取得し、ファイルが途中で切れて MCP が起動に失敗することがあった（起きる回と起きない回がある。そのセッションでは再接続されない） | 版を固定し、Setup script で事前に取得し、MCP の登録（Setup script のユーザー単位、またはリポジトリの `.mcp.json`）の `env` に `npm_config_prefer_offline=true` を付ける。修正後は3回続けて起動した |
| Docker ビルドの apt / apk | 既定のリストに Debian と Alpine の配布元が無く、Debian 系イメージの `apt-get update` が 403 で落ちる | Allowed domains に `deb.debian.org`（Alpine なら `dl-cdn.alpinelinux.org`）を足す |
| context7 MCP | 起動はするが、ツールを呼ぶと API の `context7.com` への CONNECT がプロキシに 403 で拒否される（既定の許可リストに無い） | Allowed domains に `context7.com` を足す |
| 同名の MCP | Setup script がユーザー単位で登録した MCP と、リポジトリの `.mcp.json` に同名があると `claude mcp list` に重複の警告が出る。使われるのは1件で、ツールは動く | 動作に影響しないのでそのままでよい。消すならリポジトリの `.mcp.json` 側 |
| Playwright | `/opt/pw-browsers` にプリインストールされたブラウザが、`@playwright/test` や playwright MCP の要求する版と違う | セッション初期化で `npx playwright install chromium chromium-headless-shell`、MCP は `npx @playwright/mcp@<版> install-browser chrome-for-testing` |
| Go の公式配布物 | `go.dev/dl/` の tarball は `dl.google.com` からリダイレクト配信される。`go.dev` だけを Allowed domains に足しても `dl.google.com` が 403 CONNECT tunnel failed で落ち、`/usr/local/go/bin` が無いまま `ln -sf` だけ成功して壊れたシンボリックリンクが残る | Allowed domains に `go.dev` と `dl.google.com` の両方を足す。テンプレートの Go ブロックは `set -e` でダウンロード失敗時に `ln -sf` まで進ませない（cloud-env-setup スキルで実際にクラウドセッションを試し、404/403 ではなく壊れたシンボリックリンクという形で顕在化した） |

## Network access は Custom にして既定のリストを残す

既定の Trusted に無いドメインを使うときは Custom にします。**「Also include default list of common package managers」に
チェックを入れないと、書いたドメインしか通らなくなります。** 足す候補は、Docker Hub の配信元
`production.cloudfront.docker.com`、Playwright のブラウザ配布元（`cdn.playwright.dev` /
`playwright.download.prss.microsoft.com`）、context7 の API（`context7.com`）、Debian / Alpine 系イメージのビルドで使う `deb.debian.org` / `dl-cdn.alpinelinux.org`、Go の公式配布物（`go.dev` と `dl.google.com` の両方）、業務 SaaS の API です。既定のリストの Linux ディストリビューションは Ubuntu だけで、`python:*-slim` などの Debian 系イメージの `apt-get update` は 403 になります（Microsoft Container Registry は既定に入っています）。

## GitHub の認証

GitHub への通信は専用のプロキシが認証を差し込み、`GH_TOKEN` は `proxy-injected` という仮の値になっています。
自分でトークンを置く必要はありません。GraphQL は PR 系の決まった操作しか通らず、GitHub API とリリース資産は
セッションに紐づくリポジトリにしか届きません。

## 秘密の値の渡し方

- **環境変数欄:** `.env` 形式で書くと、セッション開始時に普通の環境変数として入ります。
  その環境を使える人と、Claude が実行するコマンドからは値が読めます。**Setup script の実行中は
  使えません**（2026-09-16、使い捨て環境で実機確認済み。`$VAR` の展開結果も `env` の出力も空だった）
- **ファイルの中身をまるごと渡したいとき（QC overlay 等）:** 環境変数は Setup script の段階で
  読めないので、値ではなく中身そのものを `cat > <path> <<'EOF' ... EOF` の形で Setup script に
  埋め込む。`cloud-env-setup` の `scripts/render_qc_overlay_snippet.sh` がこの形を生成する
- **API credentials（Pro / Max のみ）:** リクエストヘッダーで送る API キーを、Claude から隠したまま
  指定ホストへのリクエストに付けられます。OAuth のクライアントシークレットのように本文で送る値は対象外です
- ローカル開発用に作っただけのパスワードや署名鍵は、渡さずにセッションごとに生成するほうが安全です

## 参考

- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/claude-code-on-the-web
