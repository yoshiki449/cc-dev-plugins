# skills/_shared — dev-* スキル共通基盤

dev-plan / dev-setup / dev-implement / dev-verify / dev-qa / dev-fix / dev-ship / auto-spec の各 SKILL.md が参照する共通リソースを置く。

| パス | 用途 |
|---|---|
| `reference/handover-template.md` | 引継書テンプレート（全フェーズ共通の骨格＋フェーズ固有セクション） |
| `scripts/latest-handover.sh` | `.agent/handover-*.md` の最新ファイルパスを返す（判定は**ファイル名の日付**。日付を持たない引継書は除外して stderr に警告） |
| `scripts/new-handover-path.sh [issue]` | 新規引継書パスを生成（衝突時はエラー） |
| `scripts/extract-issue-number.sh [handover]` | 引継書／ブランチ名から Issue 番号を抽出 |
| `reference/qc-overlay.md` | 組織固有の QC 観点を外から差し込む契約（入力／出力／責務の境界）。判定器は `scripts/qc-overlay.sh` |
| `scripts/qc-overlay.sh --phase <phase>` | overlay の適用状況を JSON 1 行で返す。判定材料は `overlay_present` ではなく `overlay_applied` |
| `reference/test-tier-model.md` | 自動／手動の振り分け基準（overlay の有無に依存しない。観点の網羅リストは overlay 側） |
| `reference/subagent-output-contract.md` | サブエージェント成果物の受け渡し契約（起動プロンプト項目・呼び出し側の義務）。消費者は下表 |
| `reference/requirement-elicitation.md` | 要求の深掘り手順（要求カード・曖昧さの検出・解決策の妥当性チェック・終了条件）。消費者は下表 |
| `reference/scope-discipline.md` | 実装・修正を頼まれた範囲で仕上げるための一文（Opus 5 の範囲拡大対策）。消費者は下表 |
| `reference/advisor-policy.md` | サブエージェントに advisor をいつ呼ばせるかと、メインセッションを `/clear` させる区切り。消費者は下表 |
| `scripts/context-size.mjs [--threshold N]` | 現在のメインセッションのコンテキスト量を JSON 1 行で返す（既定の閾値 400K。判定不能でも exit 0） |

## サブエージェント成果物の受け渡し契約の消費者

`reference/subagent-output-contract.md` の起動プロンプト項目は、**各 SKILL.md に複製で置く**。agent 起動時にプロンプト文字列へ埋め込む必要があり、実行時に他ファイルを読めないため参照1本に集約できない（`reference/core-flow.md` と同じ配り方）。

複製先はこの表で一元管理し、`scripts/subagent-output-contract.test.js` が表と実ファイルの両方を突き合わせる。**新しい消費者を足したらこの表にも足すこと**（足し忘れると検知対象から漏れる）。

| スキル | 型 | 節 |
|---|---|---|
| `dev-self-review` | file-output | `### S2. エージェント並列起動（3〜5本）` |
| `dev-implement` | file-output | `#### 2-3. 敵対的検証（adversarial-verifier の多レンズ並列・本数はゲート連動）` |
| `dev-test-ledger` | file-output | `### T3. 台帳の生成` |
| `dev-qa` | body-return | `### Q4. 観点別評価（3〜4エージェント並列）` |

## 要求の深掘り手順の消費者

`reference/requirement-elicitation.md` の「解決策の妥当性チェック」（`alternative`）と「終了条件」（`exit`）は、**各 SKILL.md に複製で置く**。reference へのリンクだけにすると、スキル実行時に reference が読まれなかった場合に挙動を決める行が効かず、テストもリンクの存在しか検査できない。

複製先はこの表で一元管理し、`scripts/requirement-elicitation.test.js` が表と実ファイルの両方を突き合わせる。**新しい消費者を足したらこの表にも足すこと**。

| スキル | alternative の節 | exit の節 |
|---|---|---|
| `dev-plan` | `### A1. 要件理解` | `### A1.8. 要求の確定 ⚠ スキップ不可` |
| `auto-spec` | `### S1. ヒアリング` | `### S1. ヒアリング` |
| `dev-fix` | `### F1. 修正希望の整理` | `### F1. 修正希望の整理` |

## スコープ規律の消費者

`reference/scope-discipline.md` の正準の文は、**各 SKILL.md に複製で置く**（理由は要求の深掘り手順と同じ）。`scripts/scope-discipline.test.js` がこの表と実ファイルを突き合わせる。

| スキル | 節 |
|---|---|
| `dev-implement` | `## 手順` |
| `dev-fix` | `### F4. ソースコードの修正` |
| `dev-loop` | `#### L1.2 implement または fix を実行` |

## advisor の扱いの消費者

`reference/advisor-policy.md` の正準の文は、エージェント定義の末尾の `## advisor の扱い` 節と、エージェント定義を経由しない起動プロンプトに**複製で置く**。`scripts/advisor-policy.test.js` がこの表と実ファイルを突き合わせる。

**エージェント定義**（`agents/` の全ファイルを1回ずつ載せる。載っていないエージェントがあるとテストが落ちる）

| エージェント | 分類 |
|---|---|
| `adversarial-verifier` | reviewer |
| `Code-Reviewer` | reviewer |
| `codex-cross-reviewer` | reviewer |
| `convention-reviewer` | reviewer |
| `requirement-coverage-checker` | reviewer |
| `simplify-reviewer` | reviewer |
| `security-tester` | reviewer |
| `autonomous-tester` | reviewer |
| `qa-explorer` | reviewer |
| `qa-goal-evaluator` | reviewer |
| `qa-technical-evaluator` | reviewer |
| `qa-ux-evaluator` | reviewer |
| `explain-diff-generator` | reviewer |
| `test-ledger-writer` | reviewer |
| `test-spec-walker` | reviewer |
| `stop-judge` | reviewer |
| `loop-supervisor` | reviewer |
| `loop-eval-grader` | reviewer |
| `feedback-interpreter` | reviewer |
| `test-writer` | implementer |
| `implementer` | implementer |
| `e2e-test-generator` | implementer |
| `japanese-coding-specialist` | implementer |
| `Debugger` | implementer |
| `tdd-implementer` | implementer |
| `designer` | none |
| `spec-writer` | none |
| `ui-designer` | none |
| `Spec` | none |
| `project-orchestrator` | none |

**スキル**（節名は「」で囲む。見出しにバッククォートを含むものがあるため）

| スキル | 文 | 節 |
|---|---|---|
| `dev-ship` | reviewer | 「#### E1.5b. セキュリティレビュー（`gates.security_review` で条件化）」 |
| `dev-qa` | reviewer | 「### Q4. 観点別評価（3〜4エージェント並列）」 |
| `dev-implement` | context-check | 「### Step 5: 引継書更新 ⚠ 必須（スキップ不可）」 |
| `dev-verify` | context-check | 「### D7. 引継書更新 ⚠ 必須（スキップ不可）」 |

## 設計方針

- **DRY**: 「最新引継書取得」「日付つきファイル名生成」「Issue番号抽出」が各SKILL.mdに散在していたのを集約
- **Progressive disclosure**: SKILL.md は `bash skills/_shared/scripts/<name>.sh` を呼ぶだけ。実装詳細はファイルを読まないと展開されない
- **1階層深まで**: 各 SKILL.md からはここを直接参照（reference をネストしない）

## 使用例（SKILL.md から）

```bash
# 最新引継書を取得
LATEST=$(bash skills/_shared/scripts/latest-handover.sh)

# 新規引継書のパスを発番（Issue 番号 4 の場合）
NEW=$(bash skills/_shared/scripts/new-handover-path.sh 4)
```
