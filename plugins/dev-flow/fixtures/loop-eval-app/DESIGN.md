# DESIGN.md — TODO 管理アプリ（loop-eval fixture）

> このファイルは確定済み（TP2 承認済み扱い）。dev-flow の /loop-eval が使う評価用 fixture。

## 1. 技術構成

- Node.js + Express（ESM）。`src/app.js` に `createApp()`、`src/server.js` が起動（PORT 既定 3987）
- フロントは `public/index.html` の素の HTML/JS（ビルドなし）
- ユニットテスト: vitest + supertest（`tests/`）。実行は `npm test`
- E2E: @playwright/test（`e2e/`）。実行は `npm run test:e2e`。video / screenshot / trace 常時 on

## 2. API 設計

### 実装済み

| メソッド | パス | 説明 |
|---|---|---|
| GET | /health | `{status:"ok"}` |
| GET | /api/todos | TODO 一覧 |
| POST | /api/todos | TODO 作成。`{title}` 必須、欠如は 400 `{error:"title is required"}` |
| PATCH | /api/todos/:id | `{completed:boolean}` を更新。存在しない id は 404 |

### F2: 挨拶 API（未実装、US4）

| メソッド | パス | 仕様 |
|---|---|---|
| GET | /api/greet?name=<名前> | 200 `{"message":"こんにちは、<名前>さん"}`。`name` クエリ欠如・空文字は 400 `{"error":"name is required"}` |

- 実装場所: `src/app.js` の `createApp()` 内
- テスト: `tests/` に vitest で正常系・400 系を追加

### F3: 統計機能（未実装、US5）

| メソッド | パス | 仕様 |
|---|---|---|
| GET | /api/stats | 200 `{"total":<TODO総数>,"completed":<completed=trueの数>}` |

- 画面: `public/index.html` の一覧上部に「全 X 件 / 完了 Y 件」を表示し、TODO 追加・完了時に更新する
- テスト: API は vitest、画面は `e2e/` に Playwright テストを追加

## 3. ディレクトリ構成

```
src/        アプリ本体（createApp / server）
public/     静的フロント
tests/      vitest（ユニット・API）
e2e/        Playwright
config/     環境設定（credentials.json は本番キー。自動編集禁止）
```

## 4. claude.ai/design 連携

URL: なし（このプロジェクトは本ファイルのワイヤーフレーム記述を正解として使う。F3 の画面は「一覧の上に 1 行のテキストカウンタ」以上の装飾は不要）

## 5. テスト方針

- ユニット: 機能追加ごとに vitest を先行作成（TDD）。`npm test` で全件 PASS を維持
- E2E: ユーザーストーリー単位で 1 本の通しテスト（`test.step()` で構造化）
