---
name: cloud-env-setup
description: Claude Code のクラウドセッション（claude.ai/code・`claude --cloud`）でリポジトリを開発できるように、対象Gitリポジトリの .claude/settings.json へ SessionStart hook を配置し、scripts/install_pkgs.sh を生成し、環境設定ダイアログの「Setup script」欄に貼るテンプレート（dev-flow などの plugin の導入を含む）を提示するスキル。ユーザーが「クラウド環境のセットアップスクリプトを作って/入れて」「このリポジトリをクラウドセッション対応にして」「claude.ai/codeで使えるようにして」「クラウドで dev-flow を使いたい」「cloud-env-setupを実行して」などと言ったら必ず使う。Setup scriptとSessionStart hookの違い（実行タイミング・環境変数の可否・キャッシュ挙動）や、クラウドに何が持ち込まれるかが絡む相談でも積極的に使うこと。ローカル専用のDocker環境構築とは別物なので混同しないこと。
---

# cloud-env-setup

クラウドセッションは、リポジトリを Anthropic 管理の VM に毎回新しく clone して動く。ローカルの `~/.claude`（CLAUDE.md・スキル・ユーザー設定の plugin・user scope の MCP）には一切アクセスできず、**コミットしたものだけが届く**。このスキルは、その前提のもとで2箇所（リポジトリの `.claude/settings.json` と、環境設定 UI の「Setup script」欄）に適切な内容を置く。

一次情報: https://code.claude.com/docs/en/cloud-environments 。ただし**公式ドキュメントと実環境が食い違う点が複数ある**（2026-09 実測、claude 2.1.270）。このスキルは実測に合わせてあり、食い違いは `references/cloud-environment-notes.md` の「ドキュメントと違っていた点」にまとめてある。

## 前提知識

### 複数リポジトリのセッションでは、リポジトリ側の hook と .mcp.json が効かない

1つのセッションに複数のリポジトリを付けると、作業ディレクトリは各リポジトリの親（VM のホームディレクトリ）になり、`CLAUDE_PROJECT_DIR` は空になる。CLAUDE.md は全リポジトリ分が読まれるが、**リポジトリに置いた SessionStart hook と `.mcp.json` は効かない**（2026-09 実測）。ユーザー単位で入れた plugin と MCP は効く。

そのため、仕組みは次の3層に置く。

| 層 | 置き場所 | 中身 |
|---|---|---|
| 共通の環境 | claude.ai の環境1つ（複数のリポジトリで使い回す） | Network access、Setup script（plugin・gh・日本語フォント・MCP のユーザー単位での登録）。テンプレートは `assets/setup-script-template.sh` |
| 共通の仕組み | dev-flow の `cloud-stack` スキルと SessionStart hook | リポジトリの発見、使い捨ての準備、CA 入りのクラウド用ビルドでのスタック起動、テスト |
| リポジトリ固有 | 各リポジトリの `.claude/cloud-stack.json` | 準備コマンド、compose、CA を入れる Dockerfile、health、テスト。書式は cloud-stack の SKILL.md |

**新しくリポジトリを対応させるときは `.claude/cloud-stack.json` を置く。** 下のスクリプトが生成するリポジトリ側の SessionStart hook（`scripts/install_pkgs.sh`）は、1リポジトリだけのセッションでしか動かない。`.claude/cloud-stack.json` を置いたリポジトリでは、dev-flow の hook と二重に動くので生成しない（`--no-hook` 相当の運用として、生成されたら消す）。


### plugin は Setup script で入れる

ユーザー設定（`~/.claude/settings.json`）の plugin はクラウドに届かない。公式ドキュメントはリポジトリの `.claude/settings.json` に `extraKnownMarketplaces` と `enabledPlugins` を書けば入るとしているが、実測では入らない（起動時のインストーラが `no marketplaces declared` で何もせず、宣言は `marketplace not registered` で捨てられる）。

plugin の読み込みはセッション起動時に1回だけなので、SessionStart hook から入れてもそのセッションには間に合わない。**Claude の起動前に走る Setup script で `claude plugin marketplace add` と `claude plugin install --scope user` を実行すると、そのセッションから使える**（Setup script の時点で `claude` コマンドはある）。`install` は既に入っていれば何もしないので、直後に `claude plugin marketplace update` と `claude plugin update` も呼ぶ（呼ばないと、dev-flow を新しい版に push しても、この環境の Setup script が既に一度走っていれば古い版のまま止まる。2026-09 実測）。テンプレートは cc-dev-plugins の `dev-flow` / `poc-flow` / `git-secret-guard` を入れる。`cc-meta` は `~/.cc-plugins/.env` が無いと止まるので入れない。

このスキルはリポジトリに plugin 宣言を書かない。書くとクラウドでは効かないうえ、Setup script で入れた分と user・project の二重に出る。利用者が既に書いている宣言は消さない。

### Setup script と SessionStart hook の違い

| | Setup script | SessionStart hook |
|---|---|---|
| 置き場所 | クラウド環境の UI 設定ダイアログ（リポジトリのファイルではない） | リポジトリの `.claude/settings.json` + `scripts/install_pkgs.sh` |
| 実行タイミング | Claude Code 起動前。**環境キャッシュが無いときだけ**（初回・Setup script か許可ホストの変更時・約7日ごと） | Claude Code 起動後、**毎セッション**（resume も含む） |
| 残るもの | 書いたファイルはスナップショットとして次のセッションに残る。起動したプロセスは残らない | 毎回やり直す |
| 用途 | plugin の導入、VM に無いツール・フォントの追加、docker イメージの取得 | 依存のインストール、`.env` の生成、サービスの起動、ブラウザの版合わせ |
| 環境変数 | **届かない** | 届く |
| 時間の目安 | 約5分以内（超えるとキャッシュが作れない） | セッション開始を待たせるので、重い処理はバックグラウンドに回す |

VM は Ubuntu 24.04・root で、`git` / `jq` / `ripgrep` / `docker`（dockerd・compose 込み）/ Python（pip・uv・poetry）/ Node 20-22 がある。**`gh` はドキュメントに反して入っていない**ので Setup script で apt から入れる（`GH_TOKEN` はプロキシが差し込む）。入らないときの GitHub 操作は GitHub MCP（`mcp__github__*`）を使う。Playwright のブラウザは `/opt/pw-browsers` にあるが、リポジトリの `@playwright/test` や playwright MCP の要求する版とずれるので、セッション初期化で `npx playwright install` する。

### リポジトリ固有の初期化は `scripts/cloud-session-init.sh` に置く

生成する `install_pkgs.sh` は、クラウドのときだけ `scripts/cloud-session-init.sh` があれば呼ぶ。`.env` の作り方やサービスの起動はリポジトリごとに違うので、スキルは汎用ロジックを持たない（プレースホルダを乱数に置換するような汎用生成は、接続文字列にパスワードを埋め込むキーや、E2E が固定値を期待するテスト用アカウントで壊れる）。CI に使い捨て環境を作る手順があれば、それをスクリプトに切り出して CI と共有するのがよい。

## 実行手順

1. 対象リポジトリで `bash <skill-dir>/scripts/apply_cloud_env_setup.sh [対象ディレクトリ]`（`--no-plugins` は互換のため受け付けるが何もしない） を実行する。スクリプトが以下を行う:
   - `package.json`（1階層下も含めて Playwright を検出）/ `requirements.txt` / `pyproject.toml`+`uv.lock` / `go.mod` / `docker-compose.yml` を検出
   - `scripts/install_pkgs.sh` を生成（既存ファイルは上書きせず警告のみ）
   - `.claude/settings.json` に SessionStart hook を**冪等に**マージ（既存キーと利用者の plugin 宣言は残す）
   - Setup script のテンプレートと注意事項を表示
2. リポジトリが `.gitignore` で `.claude/` を除外していたら、`.claude/*` ＋ `!.claude/settings.json` の形に直すよう案内する（除外されたままだとコミットできず、クラウドに届かない）
3. `.env` など gitignore 済みのファイルが起動に必要なら、`scripts/cloud-session-init.sh` を一緒に作る。重い処理（`docker compose up`・`npm ci`）は `nohup ... &` でバックグラウンドにし、ログを gitignore 済みのパスに書く。resume でも hook は走るので、flock で並走を防ぎ、完了は成功時に書く目印で判定する
   - Docker でパッケージを取得するビルドがあるなら、プロキシの CA（`/root/.ccr/ca-bundle.crt`。公的 CA ＋プロキシ CA のバンドル）をビルドに渡す。本番用 Dockerfile は変えず、各 `FROM` の直後に `COPY` とPIP_CERT / REQUESTS_CA_BUNDLE / SSL_CERT_FILE / NODE_EXTRA_CA_CERTS を足したクラウド用を元から生成し、compose の上書きで差し替えるのが実測で動いた方法（同じ Dockerfile を使う全サービスを差し替えること）
4. MCP を使うなら `.mcp.json`（project scope）に書き、`.claude/settings.json` の `enabledMcpjsonServers` に名前を入れる。project scope は user scope より優先されるので、ローカルの挙動が変わらない引数にする
   - npx で起動するサーバーは版を固定し、`"env": {"npm_config_prefer_offline": "true"}` を付け、Setup script で同じ版を事前に取得する（テンプレートのコメントを外す）。セッション開始時にその場で取得すると、ファイルが途中で切れて MCP が起動に失敗することがあり、そのセッションでは再接続されない
   - 同時に npx でブラウザなどを入れる処理は `npm_config_cache` を別のディレクトリにする
   - クラウドで MCP が使えるかは、セッション内の `claude mcp list` の表示（`⏸ Pending approval`）ではなく、ツールを実際に呼んで確かめる
5. 実行後、必ず以下をユーザーに明示する（このスキルの存在意義そのものなので省略しない）:
   - Setup script は claude.ai/code の UI への手動貼り付けが必要（API/CLI からは書けない）。plugin はこれを貼らないと入らない
   - Network access は Custom にし「既定のリストを含める」にチェックする。既定には Docker Hub のイメージ本体の配信元 `production.cloudfront.docker.com`・業務 SaaS・Playwright のブラウザ配布元・context7 の API（`context7.com`）・Debian と Alpine のパッケージ配布元（`deb.debian.org` / `dl-cdn.alpinelinux.org`）が入っていない
   - 環境変数欄の値は、その環境を使える人と Claude から読める。ローカル開発用の秘密はセッションごとに生成する
   - 変更をコミットして push するまで、クラウドには何も届かない

## ファイル構成

- `scripts/apply_cloud_env_setup.sh` — メインロジック（bash + jq、冪等）
- `scripts/apply_cloud_env_setup.test.mjs` — `node --test` 用のテスト
- `assets/setup-script-template.sh` — Setup script 欄に貼るテンプレート本体
- `references/cloud-environment-notes.md` — 実行後にそのまま提示する注意事項（届くもの・届かないもの、秘密の渡し方）
