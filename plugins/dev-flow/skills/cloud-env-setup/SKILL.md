---
name: cloud-env-setup
description: Claude Code on the web（claude.ai/code のクラウドセッション）向けに、対象Gitリポジトリへ SessionStart hook 一式（.claude/settings.json + scripts/install_pkgs.sh）を配置し、環境設定ダイアログの「Setup script」欄に貼るテンプレートを提示するスキル。ユーザーが「クラウド環境のセットアップスクリプトを作って/入れて」「このリポジトリをクラウドセッション対応にして」「claude.ai/codeで使えるようにして」「cloud-env-setupを実行して」などと言ったら必ず使う。Setup scriptとSessionStart hookの違い（実行タイミング・環境変数の可否・キャッシュ挙動）が絡む相談でも積極的に使うこと。ローカル専用のDocker環境構築（claude-docker等）とは別物なので混同しないこと。
---

# cloud-env-setup

Claude Code on the web（claude.ai/code のクラウドセッション）は、リポジトリをAnthropic管理のVMに毎回新規cloneして動く。ローカルの `~/.claude`・Docker・WSLマウント等には一切アクセスできないため、ローカル向けのセットアップ（claude-docker等）とは根本的に別物である。このスキルは、その前提のもとで正しい2箇所（環境設定UIの「Setup script」欄と、リポジトリの `.claude/settings.json`）にそれぞれ適切な内容を配置する。

## 前提知識（なぜ2箇所に分かれるか）

| | Setup script | SessionStart hook |
|---|---|---|
| 置き場所 | クラウド環境のUI設定ダイアログ（リポジトリのファイルではない） | リポジトリの `.claude/settings.json` + `scripts/install_pkgs.sh` |
| 実行タイミング | Claude Code起動前。**環境キャッシュが無い時だけ**（初回 or 設定変更時 or 約7日ごと） | Claude Code起動後、**毎セッション**（resumeも含む） |
| 用途 | クラウドVMに無いシステムツールの追加（`apt install`等） | `npm install`等、ローカルでもクラウドでも走らせたい依存解決 |
| 環境変数 | **届かない**（`.env`欄の値はセッション起動後のシェルにしか注入されない） | 届く。`GH_TOKEN`等の認証系はここに書く |
| 実行時間の目安 | 実質5分程度（超過すると環境キャッシュの構築が失敗する） | 制限は緩いが毎回走るので軽量・冪等であるべき |

クラウドサンドボックスは Ubuntu 24.04 + root権限で、`git` / `jq` / `ripgrep` / `docker`(dockerd込み) / Python(pip・uv・poetry込み) / Node 20-22 が**既にプリインストール済み**。ローカルのclaude-docker実装で手動インストールしていたものの大半（git, jq, ripgrep, python3, uv等）は不要で、実際に足りなくなりがちなのは `gh` CLI・Playwright用Chromeブラウザ・日本語フォント・`clasp`/`gws`（Google Apps Script/Workspace連携時のみ）くらいである。

一次情報: https://code.claude.com/docs/en/claude-code-on-the-web （Setup scripts / Setup scripts vs SessionStart hooks / Installed tools / Network access の各セクション）

## 実行手順

1. 対象リポジトリ（デフォルトはカレントディレクトリ）で `scripts/apply_cloud_env_setup.sh [対象ディレクトリ]` を実行する。このスクリプトが以下を全て行う:
   - `package.json` / `requirements.txt` / `pyproject.toml`+`uv.lock` / `go.mod` / `docker-compose.yml`(or `compose.yml`) / Playwrightの devDependency を検出
   - `scripts/install_pkgs.sh` を検出結果に応じた内容で生成（既存ファイルがあれば上書きせず警告のみ）
   - `.claude/settings.json` に SessionStart hook を**冪等に**マージ（既存の設定を壊さず追記。二重登録も防ぐ）
   - `assets/setup-script-template.sh` の内容を表示し、検出結果に応じてどのコメントアウト行を有効化すべきか案内
   - `references/cloud-environment-notes.md` の注意事項（Network access・環境変数の可視性）を表示
2. スクリプトが出力した「Setup script」テンプレートをそのままコピーし、**ユーザー自身が** claude.ai/code の環境設定ダイアログ（環境選択 → 設定アイコン）の「Setup script」欄に貼り付ける必要がある旨を明確に伝える。この欄への書き込みはAPI/CLIから自動化できないUI操作のため、代行はできない。
3. 検出結果でPlaywrightやdocker-composeが見つかった場合は、テンプレート内の該当ブロックのコメントを外すよう具体的に案内する。
4. 実行後、必ず以下をユーザーに明示する（このスキルの存在意義そのものなので省略しない）:
   - Setup scriptはUI側での手動貼り付けが必要
   - Network access（既定 Trusted）には kintone（`*.cybozu.com`）や Backlog（`*.backlog.com` / `*.backlogtool.com`）等の業務 SaaS ドメインが含まれないため、そこと通信するリポジトリでは Custom にしてホストを追加する必要がある
   - 環境変数（`GH_TOKEN`等）は専用シークレットストアが無く「その環境を編集できる人全員に見える」仕様である

## ファイル構成

- `scripts/apply_cloud_env_setup.sh` — メインロジック（bash + jq、冪等）
- `assets/setup-script-template.sh` — Setup script欄に貼るテンプレート本体
- `references/cloud-environment-notes.md` — 実行後にそのまま提示する注意事項
