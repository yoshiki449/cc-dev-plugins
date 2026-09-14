---
name: enable-pw-reporter
description: Playwright プロジェクトの playwright.config.{ts,js,mjs,cjs} に、dev-flow 推奨の reporter（list / html / json）とフルHD viewport・動画録画・スクリーンショット・トレースの常時有効化をマージする。dev-hub が E2E 録画を完全なテスト名で一覧できる状態にし、壊れた reporter 設定も修復する。「全プロジェクトに Playwright HTML レポートを ON にしたい」「JSON レポーターを追加したい」「画面録画とスクリーンショットを必須にしたい」「dev-hub で動画のテスト名が出ない」「playwright.config が壊れて E2E が動かない」と言われたときに必ず使う。
---

# /enable-pw-reporter — Playwright reporter 一括有効化

## 何をするスキルか

各プロジェクトの `playwright.config.{ts,js,mjs,cjs}` を機械的に書き換えて、(1) reporter 3 種類と (2) フルHD viewport ＋ 動画録画 / スクリーンショット / トレースを**常時有効**にする。

### (1) reporter 必須 3 種

| reporter | 役割 |
|---|---|
| `list` | 開発中ターミナルでの結果表示 |
| `html` | 失敗解析・スクリーンショット・トレース閲覧 |
| `json` | **`dev-hub` が `test-results/results.json` を直接読んで動画 → 完全な日本語テスト名を取得するため**（最重要） |

### (2) `use` ブロックの viewport ＋ 常時記録設定

| キー | 値 | 役割 |
|---|---|---|
| `viewport` | `{ width: 1920, height: 1080 }` | ブラウザをフルHDで開く（ユーザーの実環境に一致。未指定だと Playwright デフォルトの 1280x720 で中途半端なサイズになる） |
| `video` | `'on'` | 全テストで画面録画を取得（test-results/<dir>/video.webm が必ず生成） |
| `screenshot` | `'on'` | 全テスト完了時にスクリーンショット取得 |
| `trace` | `'on'` | 全テストで Playwright トレース取得（trace.zip） |

正準形は dev-flow plugin の `templates/playwright-reporter-snippet.ts`（`<skill-dir>/../../templates/`）で管理。書き換え後はプロジェクトのフォーマッタ（Prettier 等）を 1 回走らせるとレイアウトが整う。

## いつ起動するか

- ユーザーが「全プロジェクトに Playwright HTML レポートを有効にしたい」「JSON reporter を追加したい」「dev-hub の完全タイトル取得を有効化したい」と言ったとき
- `/dev-setup` フェーズで新規プロジェクトを立ち上げて E2E をセットアップしたとき
- 既存プロジェクトを一括 migrate したいとき
- `/enable-pw-reporter` スラッシュコマンドが叩かれたとき

## 使い方

### 単発（カレントディレクトリ）

```bash
node <skill-dir>/scripts/enable.js
```

cwd（または cwd 直下の最寄り）の `playwright.config.*` を 1 つ更新する。

### ディレクトリ指定

```bash
node <skill-dir>/scripts/enable.js --dir /path/to/project
```

指定ディレクトリを起点に `playwright.config.*` を探して更新（深さ 4 まで）。

### 一括 migrate

```bash
node <skill-dir>/scripts/enable.js --all
```

ホーム配下全体（dev-hub と同じ「マウントされたユーザーホーム」検出ロジック）を再帰スキャンし、見つかったすべての `playwright.config.*` を更新する。`SCAN_ROOTS` を `:` 区切りで渡すと走査範囲を絞れる。`node_modules` / `.git` / `dist` / `build` 等の除外パターンは内蔵。

### dry-run

```bash
node <skill-dir>/scripts/enable.js --all --dry-run
```

実際の書き換えは行わず、変更予定ファイルと diff を表示する。本番実行前に必ず確認推奨。

### 書き込み後の検証（`--verify`、既定 OFF）

```bash
node <skill-dir>/scripts/enable.js --dir /path/to/project --verify
```

書き込んだ config のディレクトリで `npx playwright test --list` を実行し、**失敗したら元の内容に書き戻して FAILED として報告**する。

このスクリプトの失敗は「書き換えは成功したが生成物が Playwright に読めない」という形で出るため、書き込み処理からは成功に見えてしまう（壊れた config が E2E を起動不能にしていた実害は、これで長期間気づかれなかった）。単一プロジェクトに適用するときは付けるのが望ましい。

既定で OFF なのは、`--all` で数十件の config に `--list` を走らせると実用的な時間で終わらないため。`@playwright/test` が解決できない環境では検証をスキップし、その旨を reason に残す（**黙って成功扱いにはしない**）。

## 挙動の詳細（idempotent）

各 `playwright.config.*` に対して以下 2 種類のパッチを順に試行する：

### reporter パッチ

1. `reporter` が配列で、トップレベルに**裸の文字列要素**（`reporter: ["html", ...]`）があれば**タプルに包んで修復**する。Playwright は配列形式の各要素にタプル（`[name]` / `[name, options]`）を要求するため、裸の文字列があると config 読み込みの時点で失敗し **E2E が1件も実行できなくなる**
2. 修復の**後に** `'json'` reporter の有無を判定する。壊れた config にも `'json'` は含まれているので、順序を逆にすると「already present」でスキップされ**永久に直らない**
3. `'json'` があり修復も不要 → **スキップ**
4. `reporter` プロパティが無い → `defineConfig({...})` 直下に reporter 配列を新規挿入
5. `reporter` プロパティが文字列（`reporter: 'html'`）→ 配列に変換。このとき**必ずタプルに包む**（`[['html'], ['json', ...]]`）
6. `reporter` プロパティが配列 → 末尾に JSON entry を append

> 判定はコメント・文字列を認識するトップレベル分割で行うため、ネストした文字列（`['html', { outputFolder: 'x' }]` の `'x'`）やコメント内の記述には反応しない。

### use ブロックパッチ

1. `use: { ... }` 内に `viewport` / `video` / `screenshot` / `trace` が**すべて揃っていれば**スキップ
2. 一部足りなければ、足りないキーだけ append（既存値は触らない — ユーザーが意図的に `'off'` や別の viewport にしている可能性を尊重）
3. `use` ブロック自体が無ければ、`defineConfig({...})` 直下に full block を新規挿入

両方とも変更なしであれば SKIPPED。どちらかでも変更があれば UPDATED として diff 表示後に書き込み。

## 操作フロー（Claude 用）

1. ユーザーから「全プロジェクトに reporter 設定を入れたい」と依頼されたら、まず `--dry-run --all` で対象と変更内容をプレビュー
2. ユーザーに確認 → OK なら `--all` で本実行（単一プロジェクトなら `--verify` も付ける）
3. 結果サマリ（変更件数 / スキップ件数 / 失敗件数）を報告。`reporter:repair` が出ていたら「壊れていた config を修復した」ことも伝える
4. `--verify` を付けなかった場合は、各プロジェクトで `npx playwright test --list` が通ることを1回確認する（**書き換え成功＝config が読める、ではない**）
5. 続けて「テストを 1 回走らせて `test-results/results.json` を生成すれば dev-hub が完全タイトルを取得できる」旨を案内

## 環境変数

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `SCAN_ROOTS` | dev-hub と同じ自動検出 | `--all` の起点ディレクトリ（コロン区切り） |
| `EXCLUDE_DIRS` | （内蔵リスト） | 追加除外したいディレクトリ名（カンマ区切り） |

## ファイル構成

```
enable-pw-reporter/
├── SKILL.md              このファイル
└── scripts/
    ├── enable.js         一括書き換え本体（Node 標準モジュールのみ）
    └── enable.test.js    reporter パッチのテスト（node --test）
```

テストの実行:

```bash
node --test <skill-dir>/scripts/enable.test.js
```

## 注意事項

- スクリプトは正規表現ベースで config を書き換える（AST パースは行わない）。複雑なケース（条件付き reporter、外部から import した変数の merge 等）は `dry-run` で diff を確認してから適用してほしい
- **生成物が正しいことは書き込みの成否では分からない**。reporter を編集するロジックを変更したら `enable.test.js` を必ず更新し、実際に Playwright が入った環境で `--verify` を1回通すこと
- 書き換え後、各プロジェクトで 1 度テストを実行すると `test-results/results.json` が生成される。それ以降は `dev-hub` の「再スキャン」ボタンを押すだけで完全タイトル表示になる
- 既存の `playwright-report` HTML reporter を消したり置き換えたりはしない（追加のみ）
