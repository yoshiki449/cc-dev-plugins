---
name: cloud-env-setup
description: Claude Code のクラウドセッション（claude.ai/code・`claude --cloud`）でリポジトリを開発できるように、対象Gitリポジトリの .claude/settings.json へ dev-flow などの plugin 宣言と SessionStart hook を配置し、scripts/install_pkgs.sh を生成し、環境設定ダイアログの「Setup script」欄に貼るテンプレートを提示するスキル。ユーザーが「クラウド環境のセットアップスクリプトを作って/入れて」「このリポジトリをクラウドセッション対応にして」「claude.ai/codeで使えるようにして」「クラウドで dev-flow を使いたい」「cloud-env-setupを実行して」などと言ったら必ず使う。Setup scriptとSessionStart hookの違い（実行タイミング・環境変数の可否・キャッシュ挙動）や、クラウドに何が持ち込まれるかが絡む相談でも積極的に使うこと。ローカル専用のDocker環境構築とは別物なので混同しないこと。
---

# cloud-env-setup

クラウドセッションは、リポジトリを Anthropic 管理の VM に毎回新しく clone して動く。ローカルの `~/.claude`（CLAUDE.md・スキル・ユーザー設定の plugin・user scope の MCP）には一切アクセスできず、**コミットしたものだけが届く**。このスキルは、その前提のもとで2箇所（リポジトリの `.claude/settings.json` と、環境設定 UI の「Setup script」欄）に適切な内容を置く。

一次情報: https://code.claude.com/docs/en/cloud-environments （What carries over from your setup / Installed tools / Setup scripts / Network access の各セクション）

## 前提知識

### plugin はリポジトリ側で宣言しないと入らない

ユーザー設定（`~/.claude/settings.json`）の `enabledPlugins` はクラウドに届かない。リポジトリの `.claude/settings.json` に `extraKnownMarketplaces` と `enabledPlugins` を書くと、セッション開始時に marketplace からインストールされる。このスキルは cc-dev-plugins の `dev-flow` / `poc-flow` / `git-secret-guard` を宣言する。`cc-meta` は `~/.cc-plugins/.env` が無いと止まるので宣言しない。

リポジトリの設定なので、**同じリポジトリをローカルで開く他のメンバーにも plugin が入る**。チームのリポジトリで使うときは先に合意を取る。宣言が不要なら `--no-plugins` を付ける。

### Setup script と SessionStart hook の違い

| | Setup script | SessionStart hook |
|---|---|---|
| 置き場所 | クラウド環境の UI 設定ダイアログ（リポジトリのファイルではない） | リポジトリの `.claude/settings.json` + `scripts/install_pkgs.sh` |
| 実行タイミング | Claude Code 起動前。**環境キャッシュが無いときだけ**（初回・Setup script か許可ホストの変更時・約7日ごと） | Claude Code 起動後、**毎セッション**（resume も含む） |
| 残るもの | 書いたファイルはスナップショットとして次のセッションに残る。起動したプロセスは残らない | 毎回やり直す |
| 用途 | VM に無いツール・ブラウザ・フォントの追加、docker イメージの取得 | 依存のインストール、`.env` の生成、サービスの起動 |
| 環境変数 | **届かない** | 届く |
| 時間の目安 | 約5分以内（超えるとキャッシュが作れない） | セッション開始を待たせるので、重い処理はバックグラウンドに回す |

VM は Ubuntu 24.04・root で、`git` / `gh` / `jq` / `ripgrep` / `docker`（dockerd・compose 込み）/ Python（pip・uv・poetry）/ Node 20-22 / PostgreSQL 16 / Redis 7 がプリインストール済み。GitHub の認証はプロキシが差し込むので `gh auth login` も `GH_TOKEN` も要らない。足りなくなりがちなのは Playwright のブラウザ・日本語フォントくらい。

### リポジトリ固有の初期化は `scripts/cloud-session-init.sh` に置く

生成する `install_pkgs.sh` は、クラウドのときだけ `scripts/cloud-session-init.sh` があれば呼ぶ。`.env` の作り方やサービスの起動はリポジトリごとに違うので、スキルは汎用ロジックを持たない（プレースホルダを乱数に置換するような汎用生成は、接続文字列にパスワードを埋め込むキーや、E2E が固定値を期待するテスト用アカウントで壊れる）。CI に使い捨て環境を作る手順があれば、それをスクリプトに切り出して CI と共有するのがよい。

## 実行手順

1. 対象リポジトリで `bash <skill-dir>/scripts/apply_cloud_env_setup.sh [--no-plugins] [対象ディレクトリ]` を実行する。スクリプトが以下を行う:
   - `package.json`（1階層下も含めて Playwright を検出）/ `requirements.txt` / `pyproject.toml`+`uv.lock` / `go.mod` / `docker-compose.yml` を検出
   - `scripts/install_pkgs.sh` を生成（既存ファイルは上書きせず警告のみ）
   - `.claude/settings.json` に SessionStart hook と plugin 宣言を**冪等に**マージ（既存キーは残し、ユーザーが `false` にした plugin は戻さない）
   - Setup script のテンプレートと注意事項を表示
2. リポジトリが `.gitignore` で `.claude/` を除外していたら、`.claude/*` ＋ `!.claude/settings.json` の形に直すよう案内する（除外されたままだとコミットできず、クラウドに届かない）
3. `.env` など gitignore 済みのファイルが起動に必要なら、`scripts/cloud-session-init.sh` を一緒に作る。重い処理（`docker compose up`・`npm ci`）は `nohup ... &` でバックグラウンドにし、ログを gitignore 済みのパスに書く
4. MCP を使うなら `.mcp.json`（project scope）に書き、`.claude/settings.json` の `enabledMcpjsonServers` に名前を入れる（クラウドでは承認ダイアログに答えられない）。project scope は user scope より優先されるので、ローカルの挙動が変わらない引数にする
5. 実行後、必ず以下をユーザーに明示する（このスキルの存在意義そのものなので省略しない）:
   - Setup script は claude.ai/code の UI への手動貼り付けが必要（API/CLI からは書けない）
   - Network access（既定 Trusted）に業務 SaaS や Playwright のブラウザ配布元は入っていない。必要なら Custom にしてホストを足す
   - 環境変数欄の値は、その環境を使える人と Claude から読める。ローカル開発用の秘密はセッションごとに生成する
   - 変更をコミットして push するまで、クラウドには何も届かない

## ファイル構成

- `scripts/apply_cloud_env_setup.sh` — メインロジック（bash + jq、冪等）
- `scripts/apply_cloud_env_setup.test.mjs` — `node --test` 用のテスト
- `assets/setup-script-template.sh` — Setup script 欄に貼るテンプレート本体
- `references/cloud-environment-notes.md` — 実行後にそのまま提示する注意事項（届くもの・届かないもの、秘密の渡し方）
