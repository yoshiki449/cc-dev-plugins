# クラウド環境設定の注意事項

## Setup script は手動貼り付けが必要

「Setup script」はリポジトリのファイルではなく、claude.ai/code の環境設定ダイアログ内のテキスト欄です。
このスキルが生成したテンプレートをコピーし、環境作成/編集画面の「Setup script」欄に貼り付けてください
（設定場所: claude.ai/code → 環境選択 → 該当環境の設定アイコン）。API/CLIから自動化できないUI操作のため、
このスキルが代わりに書き込むことはできません。

## Network access（既定Trusted）に社内SaaSドメインは含まれない

Trustedの許可リストはnpm/PyPI/GitHub/Docker Hub等の汎用パッケージレジストリのみです。
kintone（`*.cybozu.com`）や Backlog（`*.backlog.com` / `*.backlogtool.com`）等の業務 SaaS と通信する
リポジトリでは、環境のNetwork accessを **Custom** にしてこれらのホストを追加してください。

## 環境変数に専用シークレットストアはない

`GH_TOKEN`等の認証情報を環境変数欄に設定する場合、公式仕様として
「その環境を編集できる人全員に値が見える」ことを理解した上で設定してください。
また、Setup script実行中は環境変数が使えません（Claude Codeセッション起動後のシェルにのみ注入される）。
認証情報が必要な処理は Setup script ではなく SessionStart hook（本スキルが配置する
`scripts/install_pkgs.sh`）側に書いてください。

## 参考

- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/web-quickstart
