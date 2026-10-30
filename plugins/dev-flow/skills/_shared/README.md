# skills/_shared — dev-* スキル共通基盤

dev-plan / dev-setup / dev-implement / dev-verify / dev-qa / dev-fix / dev-ship / auto-spec の各 SKILL.md が参照する共通リソースを置く。

| パス | 用途 |
|---|---|
| `reference/handover-template.md` | 引継書テンプレート（全フェーズ共通の骨格＋フェーズ固有セクション） |
| `scripts/latest-handover.sh [dir] [issue]` | `.agent/handover-*.md` の最新ファイルパスを返す（判定は**ファイル名の日付**。日付を持たない引継書は除外して stderr に警告）。第2引数に Issue 番号を渡すと、ファイル名が `issue<番号>` の引継書だけから選ぶ（`issue6` は `issue67` に一致しない） |
| `hooks/clear-handover-inject.sh`（plugin の `hooks/`） | SessionStart の `clear` で、最新の引継書の要約（パス・作成日時・直前/次フェーズ・作業場所・ブランチ・Issue）を自動で注入する。全文は入れない。ブランチ名の Issue の引継書を優先し、無ければ最新を注意書きつきで入れる。再開プロンプトを置き換えず並存する。引継書より後にコミットがあれば「N 件のコミットがある（最新: ハッシュ、日時）」の鮮度警告を足す（基準は、git で追跡され未コミットの編集が無ければ引継書を最後に変更したコミット、そうでなければファイルの更新時刻。コミットの件名は出さない）。`jq` が無い環境では何も注入しない（他の hook と同じ作法） |
| `scripts/new-handover-path.sh [issue]` | 新規引継書パスを生成（衝突時はエラー） |
| `scripts/run-preconditions.sh <フェーズ列> [dir]` | `/dev-run` の前提チェック。plan / design の引継書が無ければ `missing` に出す（JSON 1 行、常に exit 0）。消費者は `dev-run` のみ |
| `scripts/resume-prompt.sh <次フェーズ> [引継書]` | `/clear` の後に貼る再開プロンプト（「/<次フェーズ> 引継書: <絶対パス>」＋作業場所）を出力。引継書を省略すると `latest-handover.sh` の結果を使う。消費者は「再開プロンプトの消費者」の表 |
| `scripts/check-handover-secrets.sh <引継書>` | 引継書に資格情報らしい行（パスワード・トークン等の代入、Bearer、URL 埋め込み、既知の接頭辞、秘密鍵）が無いか走査する。検出した値は出力せず「ファイル:行番号: 種類」だけを返す（exit 1=検出あり）。引継書をリポジトリで共有するとき、コミットの前に使う |
| `scripts/extract-issue-number.sh [handover]` | 引継書／ブランチ名から Issue 番号を抽出 |
| `reference/ui-ux-checklist.md` | UI/UX の共通チェックリスト（項目ID・区分 画/操/設・強度 必須/推奨）。消費者は `qa-ux-evaluator` / `qa-explorer` / `ui-designer`。正準の1文は `ui-ux-checklist:apply` マーカー |
| `reference/qc-overlay.md` | 組織固有の QC 観点を外から差し込む契約（入力／出力／責務の境界）。判定器は `scripts/qc-overlay.sh` |
| `scripts/qc-overlay.sh --phase <phase>` | overlay の適用状況を JSON 1 行で返す。判定材料は `overlay_present` ではなく `overlay_applied` |
| `reference/test-tier-model.md` | 自動／手動の振り分け基準（overlay の有無に依存しない。観点の網羅リストは overlay 側） |
| `reference/subagent-output-contract.md` | サブエージェント成果物の受け渡し契約（起動プロンプト項目・呼び出し側の義務）。消費者は下表 |
| `reference/requirement-elicitation.md` | 要求の深掘り手順（要求カード・曖昧さの検出・解決策の妥当性チェック・終了条件・問いの書式・論点の仕分け・本文に書いてよいもの）。消費者は下の2表 |
| `reference/scope-discipline.md` | 実装・修正を頼まれた範囲で仕上げるための一文（Opus 5 の範囲拡大対策）。消費者は下表 |
| `reference/advisor-policy.md` | サブエージェントに advisor をいつ呼ばせるかと、メインセッションを `/clear` させる区切り。消費者は下表 |
| `scripts/context-size.mjs [--threshold N]` | 現在のメインセッションのコンテキスト量を JSON 1 行で返す（既定の閾値 400K。判定不能でも exit 0） |
| `reference/confirm-policy.md` | 確認レベル（`strict` / `light`）の正準の文と、設定ファイル `docs/dev-flow/confirm-level.conf` の記法・導入手順・既知の限界。消費者は下表 |
| `scripts/confirm-level.sh --dir <パス>` | 確認レベルを JSON 1 行で返す（`level` / `source` / `file` / `warnings`）。origin の既定ブランチの ref 上の設定だけを読み、判定できないときはすべて `strict`。`--dir` は必須で、常に exit 0 |
| `reference/flow-options.md` | プロジェクト別の要否設定（`explain_diff` / `test_spec`）の正準の文と、設定ファイル `docs/dev-flow/flow-options.conf` の記法・変更方法。消費者は下表 |
| `scripts/flow-options.sh --dir <パス>` | 要否設定を JSON 1 行で返す（`explain_diff` / `test_spec` が `on` / `off` / `unset`）。origin の既定ブランチの ref 上の設定だけを読み、不明・不正値はそのキーを `unset`。常に exit 0 |

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

## 問いの書式・論点の仕分け・本文に書いてよいものの消費者

`reference/requirement-elicitation.md` の「問いの書式」（`question-format`）「論点の仕分け」（`triage`）「本文に書いてよいもの」（`evidence`）も、**各ファイルに複製で置く**。理由は上の表と同じ。agent（`spec-writer` / `designer`）は SKILL.md 経由でなくサブエージェントとして単独で動くので、reference を読まない前提で複製が要る。

表のパスは `plugins/dev-flow/` からの相対。`-` はそのファイルがその節を持たない（持たないことも allowlist として `requirement-elicitation.test.js` が検査する）。

| ファイル | question-format の節 | triage の節 | evidence の節 |
|---|---|---|---|
| `skills/dev-plan/SKILL.md` | `### A1. 要件理解` | `### A1.5. ブラインドスポットパス` | `### A7. Issue 作成` |
| `skills/auto-spec/SKILL.md` | `### S1. ヒアリング` | `### S3. 人間レビュー（TP1）` | `### S4. 確定` |
| `skills/auto-design/SKILL.md` | `### D2. 人間レビュー（TP2）` | `### D2. 人間レビュー（TP2）` | `### D3. 確定` |
| `skills/dev-fix/SKILL.md` | `### F1. 修正希望の整理` | `-` | `-` |
| `agents/spec-writer.md` | `-` | `## 信頼度・厳密さの方針` | `## 信頼度・厳密さの方針` |
| `agents/designer.md` | `-` | `## 信頼度・厳密さの方針` | `## 信頼度・厳密さの方針` |

## 具体例・細部の点検・操作フロー確認モックの消費者

`reference/requirement-elicitation.md` の「具体例による確認」（`examples`）「細部の点検」（`detail-checklist`）「操作フロー確認モック」（`flow-mock`）も、**各ファイルに複製で置く**。理由は上の2表と同じ。表の読み方も同じで、パスは `plugins/dev-flow/` からの相対、`-` は持たない行（持たないことも `requirement-elicitation.test.js` が検査する）。

| ファイル | examples の節 | detail-checklist の節 | flow-mock の節 |
|---|---|---|---|
| `skills/dev-plan/SKILL.md` | `### A3.5. 具体例による確認 ⚠ スキップ不可` | `### A1.5. ブラインドスポットパス` | `### A5.5. 操作フロー確認モック（画面変更を伴うとき）` |
| `skills/auto-spec/SKILL.md` | `### S3. 人間レビュー（TP1）` | `### S1. ヒアリング` | `-` |
| `skills/auto-design/SKILL.md` | `### D2. 人間レビュー（TP2）` | `-` | `### D1.7. 操作フロー確認モック（画面変更を伴うとき）` |
| `agents/spec-writer.md` | `## 信頼度・厳密さの方針` | `## 信頼度・厳密さの方針` | `-` |
| `agents/designer.md` | `## 信頼度・厳密さの方針` | `## 信頼度・厳密さの方針` | `-` |

## スコープ規律の消費者

`reference/scope-discipline.md` の正準の文は、**各 SKILL.md に複製で置く**（理由は要求の深掘り手順と同じ）。`scripts/scope-discipline.test.js` がこの表と実ファイルを突き合わせる。

| スキル | 節 |
|---|---|
| `dev-implement` | `## 手順` |
| `dev-fix` | `### F4. ソースコードの修正` |
| `dev-loop` | `#### L1.2 implement または fix を実行` |

## スコープ規律の例外（仕様に無い、ユーザーに見える挙動）の消費者

`reference/scope-discipline.md` の例外ブロックは、上の表と**同じ3スキル**に複製で置く。`dev-implement` と `dev-fix` は止まって聞く（`scope-discipline-gap`）。`dev-loop` は途中で止まらない設計なので、記録して境界確認で提示する（`scope-discipline-gap-loop`）。`scripts/scope-discipline.test.js` が、上の表の全スキルにどちらかが置かれていること、取り違えていないことを検査する。**新しい消費者を上の表に足したら、どちらの例外を持つかも決めること**。

## 要否設定の消費者

`reference/flow-options.md` の正準の文は、下表のスキルに複製で置く（`dev` ルーターは節を持たず、7 番の判定に直接書く）。`scripts/flow-options-docs.test.js` がこの表と実ファイルを突き合わせる。**新しい消費者を足したらこの表と `reference/flow-options.md` の表にも足すこと**。設定は `/dev-config` が書く。

| スキル | 使うキー |
|---|---|
| `dev-implement` | `test_spec` |
| `dev-verify` | `explain_diff`, `test_spec` |
| `dev-qa` | `explain_diff` |
| `dev-ship` | `explain_diff` |
| `dev` | `test_spec`（節なし） |

## 確認レベルの消費者

`reference/confirm-policy.md` の正準の文は、実装〜出荷のフェーズの **各 SKILL.md に複製で置く**（理由は要求の深掘り手順と同じ）。通常版（`confirm-policy`）は 6 スキル、途中で止まらない `dev-loop` だけが変種（`confirm-policy-loop`）。`scripts/confirm-policy.test.js` がこの表と実ファイルを突き合わせる。**新しい消費者を足したらこの表にも足すこと**。企画・設計のスキル（`dev-plan` / `auto-spec` / `auto-design`）は `light` の対象外なので載せない。

| スキル | 節 | 種別 |
|---|---|---|
| `dev-implement` | `## 手順` | `confirm-policy` |
| `dev-self-review` | `### S0. 引継書の読み込み` | `confirm-policy` |
| `dev-verify` | `### D0. 引継書の読み込み` | `confirm-policy` |
| `dev-fix` | `### F0. 引継書の読み込み` | `confirm-policy` |
| `dev-qa` | `### Q0. 引継書の読み込み` | `confirm-policy` |
| `dev-ship` | `### E0. 引継書の読み込み` | `confirm-policy` |
| `dev-loop` | `### L0. 前提確認と進捗ファイル作成` | `confirm-policy-loop` |

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

## クラウドでの実スタック確認の消費者

`reference/cloud-stack-first.md` の「正準の文」は、**各 SKILL.md に複製で置く**。クラウドセッションで実スタックを「立てられない」と書く前に、`cloud-stack.sh status` と `up --wait` を実行させる文。`scripts/cloud-stack-first.test.js` が表と実ファイルの両方を突き合わせる。**新しい消費者を足したらこの表にも足すこと**。

節名は「」で囲む。

| スキル | 節 |
|---|---|
| `dev-verify` | 「### D1. ローカル環境での動作確認」 |
| `dev-qa` | 「### Q2. 環境確認」 |

## 再開プロンプトの消費者

`reference/handover-template.md` の「再開プロンプト」節にある 2 つの文（`show`=フェーズ末尾で貼る文面を出す、`read`=フェーズ冒頭で貼られたパスを読む）は、**各 SKILL.md に複製で置く**。`scripts/resume-prompt-docs.test.js` が表と実ファイルの両方を突き合わせる。**新しい消費者を足したらこの表にも足すこと**。

節名は「」で囲む。`read` は「引継書を読み込む」見出しを持つ SKILL.md が全て載っていることをテストが検査する。

| スキル | 文 | 節 |
|---|---|---|
| `dev-plan` | show | 「### A9. 引継書作成 ⚠ 必須（スキップ不可）」 |
| `dev-design` | show | 「### D5. 引継書作成 ⚠ 必須（スキップ不可）」 |
| `dev-setup` | show | 「### B6. 引継書更新 ⚠ 必須（スキップ不可）」 |
| `dev-implement` | show | 「### Step 5: 引継書更新 ⚠ 必須（スキップ不可）」 |
| `dev-verify` | show | 「### D7. 引継書更新 ⚠ 必須（スキップ不可）」 |
| `dev-fix` | show | 「#### 引継書の作成 ⚠ 必須（スキップ不可）」 |
| `dev-test-spec` | show | 「### F6. 引継書更新」 |
| `dev-qa` | show | 「### Q7. 引継書更新 ⚠ 必須（スキップ不可）」 |
| `dev-design` | read | 「### D0. 直前フェーズの引継書を読み込む」 |
| `dev-setup` | read | 「### B0. 引継書の読み込み」 |
| `dev-implement` | read | 「### Step 0: 引継書の読み込み」 |
| `dev-verify` | read | 「### D0. 引継書の読み込み」 |
| `dev-fix` | read | 「### F0. 引継書の読み込み」 |
| `dev-test-spec` | read | 「### F0. 引継書の読み込み」 |
| `dev-qa` | read | 「### Q0. 引継書の読み込み」 |
| `dev-ship` | read | 「### E0. 引継書の読み込み」 |
| `dev-self-review` | read | 「### S0. 引継書の読み込み」 |
| `dev-loop` | read | 「### L0. 前提確認と進捗ファイル作成」 |

`dev-plan` に read が無いのは最初のフェーズで読む引継書が無いため。`dev-test-ledger` と `dev-self-review` に show が無いのは、前者が引継書を書かず、後者は書いた後に `/clear` を挟まず ship へ続くため。

`dev-qa` と `dev-fix` の再開プロンプトは次フェーズに `dev-test-ledger` を指すことがあるが、`dev-test-ledger` は引継書を読む節（T0 は Issue 番号の解決と差分チェック）を持たず、貼られた `引継書:` のパスは使わない。Issue 番号は引継書のファイル名から取れるため実害は小さい。

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
