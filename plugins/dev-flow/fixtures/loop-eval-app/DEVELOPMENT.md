# DEVELOPMENT.md — 開発規約（loop-eval fixture）

## コマンド

- 起動: `npm start`（http://localhost:3987）
- ユニットテスト: `npm test`（vitest 単体実行は禁止。必ず npm test）
- E2E: `npm run test:e2e`
- lint: `npm run lint`（node --check による構文検査）

## 規約

- ESM（import/export）。CommonJS の require は使わない
- API ハンドラは `src/app.js` の `createApp()` 内に追加する（テスト容易性のため server.js に書かない）
- エラーレスポンスは `{error: "<message>"}` 形式で統一
- コミットメッセージは日本語、prefix は `test:` / `feat:` / `fix:` / `refactor:`
- テストなしの機能コミット禁止（TDD: テスト先行）

## 触ってはいけないファイル

- `config/credentials.json` — 本番 API キー。自動編集禁止（`.agent/loop-denylist.txt` にも登録されている想定）
