---
name: dev-orchestrator
description: 開発フロー全体の自動連鎖実行。/dev-plan〜/dev-ship をプリセット経路（フル/バグ修正/小規模改善）または任意のカスタム経路で順次実行する。フェーズ境界でユーザー確認を挟み、引継書で状態を引き継ぐ。**長時間・多段の自動実行を伴うため、原則ユーザーの明示指示で起動する**。
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, gh
---

# /dev-orchestrator - 開発フロー自動連鎖実行

## 概要

`dev-plan`〜`dev-ship` の独立スキル群を、**1コマンドで経路ごと自動連鎖実行**する制御スキル。

各フェーズスキル本体には**手を加えない**。orchestrator は次の役割だけを担う:
- どのフェーズを、どの順序で実行するかを決める（経路選定）
- フェーズ境界でユーザー確認・スキップ・中断を取り扱う
- 進捗をファイルに記録し、中断・再開を可能にする

各フェーズの実体（手順）は、メインClaudeが該当スキル `skills/dev-<phase>/SKILL.md` を読み込んで実行する。**`context: fork` は使わず、メインセッションで逐次実行する**（コンテキスト肥大とユーザー確認の容易さを優先）。

## 経路パターン

| プリセット | フェーズ列 | 用途 |
|---|---|---|
| `full` | plan →（design?）→ setup → implement → verify →（fix?）→ test-spec → qa → ship | 新機能のフル開発（design は plan 引継書のUI判定で自動挿入/省略） |
| `full-ui` | plan → design → setup → implement → verify →（fix?）→ test-spec → qa → ship | UIあり新機能の明示指定 |
| `bugfix` | fix → verify → ship | バグ修正のみ |
| `small` | implement → verify → ship | 小規模改善 |
| `custom` | （ユーザー入力）| 任意のフェーズ列、例: `verify,qa,ship` |

`$ARGUMENTS` で経路を直接指定できる:
- `/dev-orchestrator full`
- `/dev-orchestrator full-ui`
- `/dev-orchestrator bugfix`
- `/dev-orchestrator implement,verify,ship`（カスタムをカンマ区切りで）

引数が空または不明な場合は O0 で AskUserQuestion により確認する。

## 手順

### O0. 経路パターンの選定

1. **再開チェック**: `ls -1 .agent/orchestrator-plan-*.md 2>/dev/null | tail -1` で最新の進捗ファイルを探す
   - 存在し、未完了フェーズが残っていれば、AskUserQuestion で「Phase X から再開しますか？/新規に経路選定しますか？」を確認
   - 再開を選んだ場合は O1 へジャンプ（残りフェーズを実行）
2. **経路確定**: 以下の優先順位で経路を決定
   - `$ARGUMENTS` に `full` / `bugfix` / `small` のいずれか → プリセット適用
   - `$ARGUMENTS` にカンマ区切り（例: `verify,qa,ship`）→ カスタムとして各要素を `dev-<name>` に解決
   - 引数なし → AskUserQuestion で「フル/バグ修正/小規模/カスタム/キャンセル」を確認
   - カスタムを選んだ場合は AskUserQuestion で対象スキル群を「複数選択」させる（`multiSelect: true`）
3. **存在チェック**: 経路中の各 `dev-<phase>` について `skills/dev-<phase>/SKILL.md`（プロジェクト or `~/.claude/`）の存在を確認。なければ即停止しユーザーに報告
4. **進捗ファイル作成**: `.agent/orchestrator-plan-<YYYYMMDD-HHMM>.md` を作成

進捗ファイルのフォーマット:
```markdown
# Orchestrator 実行計画
開始: YYYY-MM-DD HH:MM
経路: <full|bugfix|small|custom>
Issue: #<番号 or 未確定>
引数: <$ARGUMENTS>

| # | フェーズ | 状態 | 引継書 | 備考 |
|---|---------|------|--------|------|
| 1 | dev-plan | ⬜ 待機 | - | |
| 2 | dev-setup | ⬜ 待機 | - | |
...

## 凡例
⬜ 待機 / ⏳ 実行中 / ✅ 完了 / ⏭ スキップ / ❌ 中断
```

### O1. フェーズ実行ループ

経路の各フェーズについて順に以下を実行:

1. **境界確認**（AskUserQuestion）
   - 副作用大フェーズ（setup / implement / fix / ship）→ **毎回明示確認**（選択肢: 続行 / スキップ / 中断）
   - 読み取り中心フェーズ（plan / verify / qa / test-spec）→ 確認するが「以降このセッションでは自動進行する」も選択可能
   - 一度「自動進行」を選んだ後は読み取り中心フェーズは確認スキップ（フラグをセッション内で保持）
2. **進捗更新**: 当該行を `⏳ 実行中` に更新
3. **フェーズ本文の展開**: 該当スキル `skills/dev-<phase>/SKILL.md`（または `~/.claude/skills/dev-<phase>/SKILL.md`）を Read し、本文の手順をメインClaudeとしてそのまま実行
   - **重要**: 「skills/dev-<phase>/SKILL.md の手順に従って <フェーズ名>フェーズを実行してください」とメインClaudeへ指示する形でよい
   - そのフェーズスキルが要求するエージェント（qa-explorer 等）の起動・引継書の作成はフェーズ側の責任
4. **完了判定**: フェーズ終了後、`ls -1 .agent/handover-*.md | tail -1` で新規引継書を確認
   - 新しい引継書が作成されていれば ✅ 完了 とし、ファイル名を進捗ファイルに記録
   - 作成されていなければユーザーに「フェーズが正常完了したか」を AskUserQuestion で確認
5. **fix の挿入**（フル経路のみ）: verify 完了後、引継書に「修正希望あり」「未対応バグあり」が記載されていれば、fix を経路に動的に挿入（ユーザー確認の上）
6. **design の動的判定**（`full` プリセットのみ）: plan 完了後、plan 引継書の `## 画面デザインフェーズ判定` セクションを読み、`design フェーズ推奨: yes` なら design を次フェーズに挿入、`no` ならスキップして setup に進む。`full-ui` 指定時は判定を行わず必ず design を実行する

### O2. 中断・再開

- **中断**: ユーザーが「中断」を選択、またはフェーズ実行中に致命的エラーが発生したら、進捗ファイルの当該行を `❌ 中断` にし、サマリを表示して終了
- **再開**: 次回 `/dev-orchestrator` 起動時、O0 の再開チェックで未完了の進捗ファイルを検出し、中断したフェーズから再開可能

### O3. 完了報告

全フェーズ完了後、サマリを表示:
- 実行フェーズ・スキップフェーズ
- 生成された引継書のパス一覧
- 最終 PR URL（ship 完了時）
- 進捗ファイルのパス（履歴として残る）

## ブラウザ・並列リソースの注意

- 経路中に **qa** が含まれる場合、qa-explorer が Playwright MCP のブラウザを単独使用する。orchestrator から他フェーズ（verify 等）と同セッション内で同時実行しない（逐次実行モデルなので構造的に問題なし）
- エージェント並列起動の上限（最大3）は各フェーズ内で守られているため、orchestrator はそれを破らない

## 安全ルール

- `disable-model-invocation: true` により**自律起動されない**。ユーザーが `/dev-orchestrator` を明示起動した場合のみ動く
- 副作用大フェーズ（setup/implement/fix/ship）は**毎回ユーザー確認**を必須とする
- 不明な経路指定、存在しないスキル指定は即停止
- フェーズ実行中の致命的エラーは握りつぶさず、進捗ファイルに記録して中断

## カスタム経路の指定例

```
/dev-orchestrator verify,qa
  → 既に実装済みの状態で、検証→QAだけ流したい

/dev-orchestrator fix,verify,qa,ship
  → QA指摘の修正から ship までを通したい

/dev-orchestrator implement,verify
  → Phase単位のループを1サイクル分だけ
```

## このスキルが直接やらないこと

- 各フェーズの具体的な手順（plan の Issue 作成、implement の TDD サイクル等）は**フェーズスキル本体に委譲**
- `/clear` の自動実行（人間の認知負荷とコンテキスト管理はユーザーの判断に委ねる。境界確認で「中断 → /clear → 再開」を選べる）
- 失敗時の自動ロールバック（フェーズ側のコミット粒度に依存。orchestrator は中断記録のみ）
