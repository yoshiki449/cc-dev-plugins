# クラウド環境設定の注意事項

## クラウドに届くもの・届かないもの

クラウドセッションはリポジトリを毎回新しく clone した VM で動きます。コミットしたものしか届きません。

| もの | 届くか | 手当て |
|---|---|---|
| リポジトリの `CLAUDE.md`・`.claude/rules/`・`.claude/skills/`・`.claude/agents/` | 届く | — |
| リポジトリの `.claude/settings.json`（hook・plugin 宣言） | 届く | plugin はセッション開始時に marketplace からインストールされる |
| リポジトリの `.mcp.json` | 届く | 対話で承認できないので `enabledMcpjsonServers` で有効化しておく |
| `~/.claude/CLAUDE.md`・`~/.claude/skills/` | 届かない | 必要な部分をリポジトリの `.claude/rules/` などにコミットする |
| ユーザー設定でだけ有効にした plugin | 届かない | このスキルがリポジトリ側に宣言する |
| `claude mcp add` で user / local scope に足した MCP | 届かない | `--scope project` で `.mcp.json` に書いてコミットする |
| `.gitignore` 済みのファイル（`.env` など） | 届かない | `scripts/cloud-session-init.sh` でセッションごとに作る |

## Setup script は手動貼り付けが必要

「Setup script」はリポジトリのファイルではなく、claude.ai/code の環境設定ダイアログ内のテキスト欄です。
テンプレートをコピーし、環境作成/編集画面の「Setup script」欄に貼り付けてください
（設定場所: claude.ai/code → メッセージ欄の上の環境名 → 該当環境の設定アイコン）。API/CLI からは書き込めないため、
このスキルが代わりに書き込むことはできません。環境はアカウント単位なので、リポジトリごとに環境を分けると
Setup script を混ぜずに済みます。

## Network access（既定 Trusted）に業務 SaaS のドメインは含まれない

Trusted の許可リストはパッケージレジストリ・GitHub・Docker Hub・主要クラウドの SDK などです。
業務 SaaS の API や、Playwright のブラウザ配布元（`cdn.playwright.dev` / `playwright.download.prss.microsoft.com`）は
含まれません。これらと通信するリポジトリでは、環境の Network access を **Custom** にしてホストを足してください
（「既定のリストを含める」にチェックすると Trusted の分も残ります）。

## GitHub の認証は要らない

`gh` はプリインストール済みで、GitHub への通信は専用のプロキシが認証を差し込みます。`GH_TOKEN` を
環境変数に置く必要はありません。ただし GraphQL は PR 系の決まった操作しか通らず、
GitHub API とリリース資産はセッションに紐づくリポジトリにしか届きません。

## 秘密の値の渡し方

- **環境変数欄:** `.env` 形式で書くと、セッション開始時に普通の環境変数として入ります。
  その環境を使える人と、Claude が実行するコマンドからは値が読めます。Setup script の実行中は使えません
- **API credentials（Pro / Max のみ）:** リクエストヘッダーで送る API キーを、Claude から隠したまま
  指定ホストへのリクエストに付けられます。OAuth のクライアントシークレットのように本文で送る値は対象外です
- ローカル開発用に作っただけのパスワードや署名鍵は、渡さずにセッションごとに生成するほうが安全です

## 参考

- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/claude-code-on-the-web
