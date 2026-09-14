---
name: dev-hub
description: 開発成果物を1つのブラウザ UI で横断閲覧・レビューする成果物ハブ。E2E 録画・設計ドキュメント（docs/）・採用プラン（docs/plans/）・explain-diff 理解ドキュメントをリポジトリ横断で一覧し、範囲選択や動画フレームにコメントを付けて Claude Code への修正指示として取り出せる。ユーザーが「成果物を見たい」「成果物ハブ」「ドキュメントハブ」「dev-hub を起動」「E2E の動画を見たい」「Playwright の録画を一覧したい」「テスト動画ビューア」「録画をスロー再生したい」「explain-diff を一覧したい」「設計ドキュメントを横断で見たい」「成果物にコメントを付けたい」「レビューコメントを JSON にしたい」「動画にコメントしたい」と言ったときに必ず起動する。
---

# /dev-hub — 開発成果物ハブ

## 何をするスキルか

複数プロジェクトに散らばる開発成果物を一箇所で見るための **ローカル Web ビューア** を起動する。

| 種類 | スキャン対象 | ビューア |
|---|---|---|
| 🎬 動画 | `~/` 配下の `.webm` / `.mp4`（E2E 録画） | プレイヤー（既定 0.25x スロー再生） |
| 📄 ドキュメント | 各 git リポの `docs/**/*.md` | md レンダリング表示 |
| 📋 プラン | 各 git リポの `docs/plans/**/*.md`＋`~/.claude/plans/*.md`（未取り込み分） | md レンダリング表示 |
| 🧪 テスト台帳 | 各リポの `.agent/test-ledger/**/*.md`（`/dev-test-ledger` の出力） | md レンダリング表示 |
| 🧾 レポート | 各リポの `.agent/reports/**/*.md`（正式な置き場所・パターン不問）＋旧形式互換（`.agent/` 直下の `qa-report-*` / `security-review-*` / `security-check-*` / `triage-*`）＋ `.agent/evidence/**` の `findings-*` / `qa-brief*` / `qa-report*` | md レンダリング表示 |
| 💡 説明 | 各 git リポの `.agent/explanations/**/*.html`＋`~/.claude/explanations/*.html`（未取り込み分） | sandbox 付き iframe |

- スキャン仕様は**ドキュメント保管規約**（`/doc-standard`、`~/.claude/best-practices/IMPLEMENTATION.md`）と一致する。規約に準拠したリポほど成果物が正しく表示される
- 配信: `http://localhost:7777`（loopback バインドのみ）
- 依存: Node.js 標準モジュールのみ（外部 npm パッケージ不要）
- リポジトリの `.claude/worktrees/` 配下の worktree もプロジェクト内の worktree としてスキャンされる
- `.git` は無いが `.agent/` を持つディレクトリは**傘プロジェクト**として扱う（例: `hrms/` が配下に backend/frontend の git リポを持ちつつ、傘自身の docs/ や QA レポートを持つ構成。傘と配下リポの両方がスキャンされる）

## いつ起動するか

- ユーザーが「成果物を見たい」「成果物ハブ」「E2E の動画を見たい」「explain-diff を一覧したい」「設計ドキュメントを横断で見たい」と言ったとき
- auto-build / auto-feedback 完走後、成果物（動画・explain-diff・設計md）をまとめてレビューしたいとき
- `/dev-hub`（旧 `/dev-videos`）スラッシュコマンドが叩かれたとき

## 使い方

### 起動

```bash
node <skill-dir>/scripts/server.js
```

`http://localhost:7777` をブラウザで開く（WSL の場合は Windows 側のブラウザから自動的にフォワードされる）。

### 停止

foreground 起動なら `Ctrl+C`、`run_in_background` で起動した場合は該当ジョブを `kill`。

### オプション

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `7777` | 待受ポート |
| `SCAN_ROOTS` | `$HOME` | スキャン対象ディレクトリ（コロン区切りで複数可） |
| `GLOBAL_DIRS` | `~/.claude/explanations:~/.claude/plans` | グローバル成果物（未取り込み分）のディレクトリ（コロン区切り） |
| `EXCLUDE_DIRS` | （内蔵リスト） | 追加除外ディレクトリ名（コンマ区切り）。**`.claude` を追加しないこと**（worktree 成果物が消える） |
| `MAX_DEPTH` | `12` | スキャンの最大階層深さ |
| `ALLOW_DELETE` | 無効 | `1` で動画の削除ボタンを有効化（動画のみ。ドキュメントは削除不可） |

## 操作フロー（Claude 用）

1. ユーザーが起動を求めたら、`Bash` で `node <skill-dir>/scripts/server.js` を **`run_in_background: true`** で実行
2. 起動を確認したら `http://localhost:7777` を開くよう案内
3. 「終了」「閉じて」と言われたら background job を `kill`

### Docker コンテナ内から起動する場合の注意（ERR_EMPTY_RESPONSE 対策）

claude-docker を**複数コンテナ並行起動**していると、ホスト側の公開ポートは自動オフセットされる（例: 2つ目のコンテナは `7778->7777`、3つ目は `7779->7777`）。ホストの 7777 は最初のコンテナが持っており、そのコンテナで dev-hub が動いていなければブラウザは ERR_EMPTY_RESPONSE になる。

- 案内する前に、ユーザーにホスト側で `docker ps --format '{{.ID}}\t{{.Ports}}'` を実行してもらい、**現在のコンテナ（`hostname` で ID 確認）の 7777 がホストのどのポートに割当てられているか**を特定して、そのポート（例: `http://localhost:7779`）を案内する
- もしくは WSL ホスト側で直接 `node <パス>/server.js` を起動する（Node 標準のみなので npm install 不要。ホスト起動なら常に localhost:7777 で開ける）

## UI の構成

- **サイドバー**: 先頭に「🏃 実行履歴」（実行マニフェストがある場合のデフォルトビュー）と「📥 インボックス」（全プロジェクト横断・新しい順）、以下プロジェクト一覧（成果物件数バッジ。グローバル未取り込み分は `(グローバル)`）
- **実行履歴ビュー**: 開発フロー1サイクル（＝1つの実行マニフェスト）ごとの折りたたみセクション。プラン → 設計 → 説明 → 動画がその実行の単位でまとまって時系列表示される。最新の実行だけ展開された状態で開く
- **種類フィルタ**: すべて / 🎬 動画 / 📄 ドキュメント / 📋 プラン / 🧪 テスト台帳 / 🧾 レポート / 💡 説明（件数付きチップ）
- **インボックスビュー**: 全成果物を mtime 降順のフラットリストで表示（種類アイコン・タイトル・プロジェクト・日時）
- **プロジェクトビュー**: 種類セクション順に表示。動画は worktree → カテゴリ（user-stories / functional）のグルーピング
- **検索ボックス**: タイトル・プロジェクト名・パスの部分一致
- **動画プレイヤー**: 速度切替（0.25x〜2.0x、初期値 0.25x）、前後ナビ、削除（`ALLOW_DELETE=1` 時のみ）
- **ドキュメントビューア**: md はレンダリング表示、explain-diff HTML は sandbox iframe（クイズ等のスクリプトは動作、ハブ本体へのアクセスは不可）

## コメント機能（レビュー → Claude Code への修正指示）

mce（markdown-comment-exporter）由来のコメントエンジンを内蔵している。**mce 単体 CLI は存続**し、JSON スキーマは mce 互換（quote / startLine / endLine / comment）。

| 対象 | 付け方 | 位置情報 |
|---|---|---|
| 📄 md（doc / plan） | 本文テキストを範囲選択 → ポップオーバーで入力（Ctrl+Enter 保存） | ソース行番号（`data-source-line`＋行精緻化。特定不能時はブロック先頭行） |
| 💡 explanation（HTML） | iframe 内で範囲選択 → 同様 | quote のみ（生成 HTML のためソース行は記録しない） |
| 🎬 動画 | プレイヤーの「📸 このフレームにコメント」→ 現在フレームを PNG 保存して入力 | timestamp（秒）＋ screenshot（PNG 絶対パス） |

- **自動保存**: コメントは追加・編集・削除のたびに対象ファイルの隣の `<ファイル名>.comments.json` へ書き込まれる（サーバ再起動でも消えない）。動画のフレーム画像は `<動画>.frame-<ms>.png`
- **JSON コピー**: mce 互換のエクスポート JSON をクリップボードへ
- **プロンプトコピー**: 修正指示の前文＋JSON を一体のテキストでコピー → そのまま Claude Code へ貼り付けて修正依頼（動画は「screenshot を Read で開いて確認せよ」という動画用の前文になる）
- **📮 inbox（/auto-feedback 連携）**: コメント全量を対象プロジェクトの `<プロジェクトルート>/.agent/feedback-inbox/<item-id>.json` に書き出す（`POST /api/feedback-inbox?id=<id>`、同一成果物は上書き）。成功時、取り込みコマンド `/auto-feedback --inbox <書き出し先絶対パス>` がクリップボードにコピーされるので、Claude Code セッションにそのまま貼り付ければ取り込まれる。プロジェクトルートは成果物パスから `.git`（worktree の `.git` ファイル含む）または `.agent` を持つ直近の親を探して決める。どちらも無い成果物（`~/.claude` 配下のグローバル成果物等）は書き出せずエラー表示になる
- コメント一覧はサイドパネルに表示。クリックで該当箇所へスクロール（動画はタイムスタンプへジャンプ）、ホバーでハイライト強調
- 対象ファイルの場所が読み取り専用の場合、保存はエラー表示になる（クラッシュしない）

## 実行マニフェスト（.agent/hub-runs/）

「実行履歴ビュー」の元データ。**1開発サイクル = 1マニフェスト**で、各フェーズが成果物を追記していく:

- 置き場所: `<repo>/.agent/hub-runs/<run-id>.json`
- run-id の慣例: Issue があれば `issue-<番号>`、なければ `<YYYYMMDD-HHMM>-<slug>`
- スキーマ: `{ run_id, label, flow, issue, updated_at, artifacts: [{ path }] }`（path はリポルート相対）
- 追記は共通ヘルパーで行う（idempotent・存在しないファイルは自動スキップ）:

```bash
node skills/_shared/scripts/hub-run-add.mjs --repo <repoルート> \
  --run issue-12 --label "機能名" --flow dev-plan --issue 12 <成果物パス>...
```

- 書き込み側: dev-plan（採用プラン）・auto-build / auto-feedback（DESIGN / explain-diff / レビュー動画）・dev-ship（explain-diff / QA / security-review）・explain-diff（手動実行）
- マニフェストに記載されていれば、スキャン仕様外のファイル（`.agent/qa-report-*.md` 等）も dev-hub で閲覧できる

## 完全タイトル取得を有効化する（動画・推奨）

動画のタイトル解決は (1) Playwright JSON reporter の `results.json`（最優先）→ (2) `playwright-report/index.html` 内 zip → (3) ディレクトリ名推定 の順。各プロジェクトへの JSON reporter 追加は `/enable-pw-reporter` で一括設定できる。

md のタイトルは先頭の見出し行、HTML は `<title>` から解決する。

## セキュリティ

- サーバは **`127.0.0.1` (loopback) のみ bind**（Docker 内では 0.0.0.0）
- 配信エンドポイント（`/video` `/doc`）は起動時スキャンで見つかったファイルの id（パスの SHA1）としか照合しない（パストラバーサル防止）
- md は `text/plain` で配信しフロント側でエスケープ後にレンダリング。explain-diff HTML の iframe は `sandbox="allow-scripts"`（`allow-same-origin` なし）で表示
- 削除エンドポイントは動画のみ・`ALLOW_DELETE=1` 時のみ

## ファイル構成

```
dev-hub/
├── SKILL.md                  このファイル
├── scripts/
│   ├── server.js             HTTP サーバ（標準 http モジュール）
│   ├── scan.js               動画スキャン
│   ├── scanDocs.js           ドキュメント／プラン／説明 HTML スキャン
│   ├── titleResolver.js      md 見出し・HTML <title> 抽出
│   ├── commentStore.js       コメントのサイドカー永続化（write-through）
│   ├── feedbackInbox.js      📮 feedback-inbox 書き出し（/auto-feedback --inbox 連携）
│   ├── config.js             設定ロード
│   ├── zipReader.js          標準 zlib だけで zip を読む
│   ├── reportReader.js       playwright-report からテスト情報抽出
│   ├── jsonReportReader.js   Playwright JSON reporter のパーサ
│   └── *.test.mjs            ユニットテスト（node --test）
└── public/
    ├── index.html            ビューア UI
    ├── app.js                フロント JS
    ├── mdRender.js           簡易 Markdown レンダラ（XSS セーフ・data-source-line 注釈付き）
    ├── commentCore.js        コメント純関数（行精緻化・エクスポート・プロンプト生成）
    ├── commentUi.js          コメント UI（選択・ハイライト・パネル・iframe ブリッジ）
    ├── iframe-agent.js       explanation iframe への注入スクリプト
    └── style.css             スタイル
```

## 関連

- スキャン仕様の元となる規約: `/doc-standard`（ドキュメント保管規約）
- 動画タイトル解決の設定: `/enable-pw-reporter`
- コメントエンジンの移植元: mce（markdown-comment-exporter）。単体 CLI として存続、JSON スキーマ互換
- 旧 `/dev-videos` は本スキルへの互換エイリアス
