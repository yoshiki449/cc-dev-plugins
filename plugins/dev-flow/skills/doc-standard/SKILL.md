---
name: doc-standard
description: ドキュメント保管規約（docs/ はレビュー文書で git 管理、docs/plans/ は採用プラン、.agent/ は全面 gitignore、ルート直下はツール規定ファイルのみ）への準拠チェックと一括移行を行う。対象は1リポジトリ・指定ディレクトリ・ホーム配下一括のいずれかで、コミットはしない。ユーザーが「ドキュメント規約に準拠させて」「docs/ に移行して」「.agent を gitignore にして」「ドキュメントの置き場所を整理して」「doc-standard を実行して」「保管規約チェックして」と言ったら必ず使う。
---

# /doc-standard — ドキュメント保管規約への一括移行

## 何をするスキルか

各 git リポジトリを **ドキュメント保管規約** に準拠させる移行スクリプトを実行する。

規約の全体像は `~/.claude/best-practices/IMPLEMENTATION.md` の「ドキュメント保管規約」を参照。要点：

| 場所 | 内容 | git |
|---|---|---|
| ルート直下 | ツールが配置場所を規定する md のみ（README / CLAUDE / AGENTS / GEMINI / LICENSE / CONTRIBUTING / CHANGELOG / CODE_OF_CONDUCT / SECURITY） | tracked |
| `docs/` | レビュー対象の設計文書（REQUIREMENTS / DESIGN / SPEC / OPERATIONS / RUNBOOK） | **tracked** |
| `docs/plans/` | 採用した Plan mode プラン（`YYYY-MM-DD-<トピック>.md`） | **tracked** |
| `.agent/` | エージェント運用ファイル（handover / evidence / autopilot / explanations 等） | **全面 gitignore** |
| `.agent/reports/` | サマリレポート（qa-report / security-review / security-check / triage）。dev-hub の 🧾 レポート表示対象 | gitignore |

スクリプトが自動で行うこと（すべて idempotent）：

1. ルート直下の設計系 md（`REQUIREMENTS*.md` / `DESIGN*.md` / `SPEC*.md` / `OPERATIONS.md` / `RUNBOOK.md`）を `docs/` へ移動（tracked なら `git mv`。隣接する `<名前>.md.comments.json` も一緒に移動）
2. ルート直下の `HANDOVER*.md` を `.agent/` へ移動（index からも外す）
3. `.agent/` 直下の旧形式レポート（`qa-report-*` / `security-review-*` / `security-check-*` / `triage-*`）を `.agent/reports/` へ移送（gitignore 内の fs 移動のみ）
4. `.gitignore` に `.agent/` を追記（`handover-*.md` のような部分除外しかない場合も全面行を追加）
5. tracked になっている `.agent/` 配下を `git rm -r --cached` で index から削除（ローカルファイルは残る）
6. 判断できない md は `[MANUAL]`、移動ファイルへの参照が残る md は `[LINK]` として**報告のみ**

**コミットは行わない**。適用後の変更はリポジトリごとに人間または Claude がレビューしてコミットする。

## いつ起動するか

- ユーザーが「ドキュメント規約に準拠させて」「docs/ に移行して」「ドキュメントの置き場所を整理して」と言ったとき
- `/doc-standard` スラッシュコマンドが叩かれたとき
- dev-plan / auto-spec で新規プロジェクトを開始した直後の規約適用

## 使い方

### 単発（cwd の最寄りリポジトリ）

```bash
node <skill-dir>/scripts/migrate.js --dry-run   # まず必ず dry-run
node <skill-dir>/scripts/migrate.js             # 適用
```

### ディレクトリ指定（配下のリポジトリを走査、深さ6）

```bash
node <skill-dir>/scripts/migrate.js --dir ~/projects --dry-run
```

### 一括 migrate（ホーム配下すべて、深さ8）

```bash
node <skill-dir>/scripts/migrate.js --all --dry-run
SCAN_ROOTS="$HOME/projects" node <skill-dir>/scripts/migrate.js --all
```

### オプション・環境変数

| 指定 | 説明 |
|---|---|
| `--dry-run` | 書き込みせず実行予定を表示 |
| `--force` | working tree が dirty（追跡済みファイルに変更あり）のリポも処理 |
| `SCAN_ROOTS` | `--all` の走査起点（コロン区切り。既定はホーム配下） |
| `EXCLUDE_DIRS` | 追加除外ディレクトリ名（コンマ区切り。`_archive` / `archive` は常に除外） |

## 出力の読み方

- `[UPDATED]` … 変更を適用した（dry-run 時は `WOULD UPDATE`）
- `[SKIPPED]` … 既に規約準拠（idempotent）
- `[DIRTY]` … 追跡済みファイルに未コミット変更があるためスキップ（`--force` で強行）
- `[MANUAL] <file>` … 許可リスト外だが設計系と断定できない md。**ユーザーと個別判断する**（レビュー文書なら docs/、運用メモなら .agent/）
- `[LINK] <file>:<行>` … 移動したファイルへの参照が残っている。リンク切れの可能性を手動確認
- 末尾 `summary: updated= partial= skipped= dirty= failed= manual-files=`

## 操作フロー（Claude 用）

1. **必ず `--dry-run` から実行**し、結果サマリをユーザーに提示する
2. `[MANUAL]` があれば AskUserQuestion で移動先（docs/ / .agent/ / 現状維持）を確認する
3. 適用実行後、`git status` で変更を確認し、リポジトリごとにコミットする（例: `chore: ドキュメント保管規約に準拠（docs/ 移動・.agent/ を gitignore）`）
   - ⚠ **コミットに pathspec を付けないこと**（`git commit -- <paths>` 禁止）。pathspec コミットは「index の staged 削除」ではなく「作業ツリーの内容」を記録するため、`git rm --cached` した `.agent/` の削除が**消えて**追跡されたままになり、逆に作業中の `.agent/knowledge.md` 等の内容変更を拾ってしまう（2026-07-08 実地で確認）。dirty リポで無関係な staged 変更を分離したい場合は、先に `git restore --staged <無関係パス>` で退避してから **pathspec なしの `git commit`** を使う
   - pre-commit hook が環境不足で落ちるリポ（husky / pre-commit 未インストール等）は、この chore コミットに限り `--no-verify` を許容
4. `[LINK]` 報告があれば該当 md のリンクを手動で修正してから同じコミットに含める（docs/ 内同士の相対リンクは移動後も成立するので対応不要。ルート README からの `](DESIGN.md)` 等だけ `docs/` 前置きに直す）
5. push は各リポジトリの運用（リモート有無・ブランチ戦略）を確認してから行う
6. 最後に再度 `--dry-run` を実行し、`updated=0` （冪等）になっていることを確認する

## テスト

```bash
node --test <skill-dir>/scripts/migrate.test.mjs
```

## ファイル構成

```
doc-standard/
├── SKILL.md              このファイル
└── scripts/
    ├── migrate.js        移行スクリプト（Node 標準モジュールのみ）
    └── migrate.test.mjs  ユニットテスト（node:test）
```

## 注意事項

- 本スキルは **git 操作（git mv / git rm --cached / .gitignore 編集）を行うが、コミットは行わない**
- `.agent/` を gitignore にした後、PR から証跡を参照したい場合はファイルリンクではなく PR コメントに内容を貼るか docs/ へ昇格する
- ネストしたリポジトリ（submodule 等）には降りない
