---
name: dev-qa
description: QAフェーズ。全Phaseの実装・検証完了後、ship前に1回実施。厳密なテスト手順を書かず、前提とゴールだけをAIエージェントに渡してPlaywright MCPでブラウザを自律探索させ、ゴール到達性・エラー有無・ユーザビリティ・画面崩れを観点別に評価する。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch, mcp__playwright__*, gh
---

# /dev-qa - QAフェーズ

## リファレンス

- **QC overlay 契約**: [../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)（組織固有の QC 観点の差し込み方。観点そのものは dev-flow に同梱しない）
## 組織固有の QC 観点（overlay）

dev-flow は組織固有の品質観点を同梱しない。フェーズの開始時に overlay の適用状況を判定する。

```bash
bash <skill-dir>/../_shared/scripts/qc-overlay.sh --phase qa
```

- `overlay_applied` が `1` → `file` のパスを Read し、並んでいる観点をこのフェーズの追加レンズとして適用する
- `overlay_applied` が `0` → 観点を**自作せずスキップする**（組織の QC を dev-flow が発明してはいけない）

どちらの場合も **適用したかスキップしたかを1行報告する。黙って素通りしない。** `warnings` があれば添える。
判定が `overlay_present` ではなく `overlay_applied` を見ている理由を含む契約は
[../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)。

`overlay_applied` が `1` かつ `reviewer_agent` が非空のときだけ、Q4 の観点別評価に
4本目として `reviewer_agent` を足す。どちらかが欠ければ**3並列**で実施し、
Q5 の統合レポートに「組織固有 QC レンズ ⏭ 未起動」の行を残す（消すと軽い経路を
通ったことが後から監査できない）。

- **サブエージェント成果物の受け渡し契約**: [../_shared/reference/subagent-output-contract.md](../_shared/reference/subagent-output-contract.md)

## 概要

> **このフェーズが必須になる条件**: 変更が**リスク HIGH かつ frontend + backend の
> 両スコープ**に跨る場合、判定器が `gates.qa == "required"` を返し、**`dev-ship` の E0.7 が
> dev-qa の未実施を検出したら PR 作成前に中断する**。小規模経路（`implement → verify → ship`）で
> 飛ばしたつもりでも、ship で引き止められる。
>
> 理由: self-review / security-review / test-ledger は**変更差分しか見ない**ため、
> 「本来あるべきなのに追加コミットが無いファイル」を原理的に検知できない
> （memory `feedback_diff_review_blindspot`）。差分レビューを軽くするほど、
> ブラウザを自律探索するこのフェーズが最後の catch layer になる。

verifyが「仕様準拠の確認（E2Eテストコードの生成・実行）」であるのに対し、QAフェーズは**利用者視点の品質評価**を行う。厳密なテスト手順は書かない。「前提」と「ゴール」だけをエージェントに渡し、初見のユーザーとしてブラウザを自律探索させ、以下の観点で評価する:

1. **ゴール到達性**: 目的を達成できる導線になっているか
2. **技術エラー**: コンソール・ネットワーク・画面上のエラーが出ないか
3. **ユーザビリティ**: 画面は分かりやすいか
4. **レイアウト**: 画面崩れはないか
5. **組織固有 QC**（overlay がある環境のみ）: 組織の QC チェックリスト準拠。overlay が無ければこの観点は評価されず、その事実をレポートに残す

## エージェント構成（探索1 → 評価3〜4並列）

| エージェント | 役割 | ブラウザ | 実行 |
|---|---|---|---|
| qa-explorer | 自律探索・証跡収集（評価はしない） | 使う | 1段目・**単独** |
| qa-goal-evaluator | ゴール到達性・導線の評価 | 使わない | 2段目・4並列 |
| qa-technical-evaluator | コンソール/ネットワーク/画面上エラーの評価 | 使わない | 2段目・4並列 |
| qa-ux-evaluator | ユーザビリティ＋レイアウト崩れの評価（スクショを画像として読む） | 使わない | 2段目・4並列 |
| overlay の `reviewer_agent` | 組織固有 QC 観点の準拠チェック（overlay がある環境のみ。無ければこの行は起動しない） | 使わない | 2段目・4本目（任意） |

## 手順

### Q0. 引継書の読み込み
1. 最新の引継書を読み込む: `ls -1 .agent/handover-*.md | tail -1`
2. Issue URL・ブランチ名・環境情報（ポート・ログイン情報）を確認
3. **全Phaseの実装・検証が完了していることを確認**。未完了のPhaseがあれば `/dev-verify` または `/dev-implement` を案内して中断する

### Q1. QAブリーフの作成（前提とゴールの収集）

以下の優先順位で情報を収集する: ①引継書 → ②GitHub Issue（`gh issue view`）→ ③DESIGN.md → ④ユーザーへの質問（AskUserQuestion）

| 項目 | 第1ソース | 第2ソース | 最終手段 |
|---|---|---|---|
| Issue URL・スコープ | 引継書 | `gh issue view` | ユーザーに質問 |
| ゴール（ユーザーストーリー） | GitHub Issueのユーザーストーリー | DESIGN.md | ユーザーに質問 |
| 起動URL・ポート | 引継書の環境情報 | docker-compose.yml / DEVELOPMENT.md | ユーザーに質問 |
| ログイン情報 | 引継書 | `e2e/tests/helpers/auth.ts` 等の既存テスト | ユーザーに質問 |
| テストデータ | 引継書 | Q2でAPI経由作成 | ユーザーに質問 |

収集した内容を `.agent/evidence/<Issue番号>/qa/qa-brief.md` として保存する:

```markdown
# QAブリーフ - Issue #<番号>

## 前提
- Issue: <URL>
- 起動URL: http://localhost:<port>
- ログイン情報: <メール/パスワード>（ロール別に複数可）
- テストデータ: <QA用に作成済みのデータと識別子>
- 対象外: <今回のIssueスコープ外の画面・機能>

## ゴール
- G1: <ユーザーストーリー由来の最終ゴール>（達成条件: <観察可能な状態>）
- G2: ...
```

**⚠ 最重要ルール: ブリーフに操作手順・テストケースを書いてはならない。** 手順を書くと自律探索が「手順の実行」に堕ち、初見ユーザー視点の導線評価ができなくなる。ゴールは「達成条件＝観察可能な状態」として書く（例:「○○が一覧に表示されている」）。

### Q2. 環境確認
1. アプリが起動していることを確認（`curl` で起動URLへの到達確認。落ちていれば起動するか、ユーザーに起動を依頼）
2. ログイン情報で認証が通ることを軽く確認（`mcp__playwright__browser_navigate` でログイン画面到達まで）
3. QA用テストデータの有無を確認。なければAPI経由で作成する（**テストデータがないことを理由にQAをスキップしてはならない**。verify D2と同じ原則）

### Q3. 自律探索・証跡収集（qa-explorer・単独実行）
1. **`dev-flow:qa-explorer` エージェント**に以下を渡して起動する:
   - QAブリーフのパス（`.agent/evidence/<Issue番号>/qa/qa-brief.md`）
   - 証跡保存先（`.agent/evidence/<Issue番号>/qa/`）
2. **⚠ ブラウザは1セッションのため、qa-explorer の実行中はメインセッション・他エージェントによるブラウザ操作を行わない**
3. 探索中はスクリーンショットに加えて**レビュー用動画を録画**する（1ゴール1動画。`browser_start_video` / `browser_stop_video` を使用）
4. 出力: 証跡一式（exploration-log.md / screenshots/ / videos/ / console-messages.md / network-requests.md）

### Q4. 観点別評価（3〜4エージェント並列）

> **重要（ハーネス制約）**: サブエージェントは basename が `findings…` で始まる `.md` を Write できない。Claude Code が `agentId` を持つ実行での `/^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i` 書き込みを拒否する（telemetry: `tengu_subagent_md_report_blocked`）。したがって **評価エージェントには findings ファイルを書かせない。所見は最終メッセージ本文で全文返させ、メインセッション（`agentId` を持たないため書ける）が逐語保存する。**

1. 以下のエージェントを**1メッセージで並列起動**する（並列上限4）。各エージェントは**所見を最終メッセージのテキストとして全文返す**（ファイルは書かない）:
   - **`dev-flow:qa-goal-evaluator`** → 保存先 `findings-goal.md`
   - **`dev-flow:qa-technical-evaluator`** → 保存先 `findings-technical.md`
   - **`dev-flow:qa-ux-evaluator`** → 保存先 `findings-ux.md`
   - **overlay の `reviewer_agent`**（`overlay_applied=1` かつ非空のときだけ）→ 保存先 `findings-overlay-qc.md`
2. 各エージェントにはQAブリーフのパスと証跡ディレクトリ、および**成果物の受け渡し契約4項目（本文返却型）**を渡す。次の4行をプロンプトに**そのまま含める**:

   <!-- subagent-output-contract:body-return -->
   1. 調査に使ってよいツール呼び出しは **N 回まで**（呼び出し側が数値を入れる。**ハーネスのターン上限より小さい値にする**）。N 回に達したら調査を止める
   2. 調査が不完全でも、必ず所見を最終メッセージ本文で全文返す
   3. 完了通知だけで終えるのは失敗とみなす。本文そのものが成果物
   4. 指摘が0件なら「0件」と明記して返す
   <!-- /subagent-output-contract:body-return -->

3. **overlay の `reviewer_agent` には追加で** 判定器が返した `file` のパスを渡す（そのファイルに並ぶ観点を全て見る）。`overlay_applied=0` のときはこの1体を起動せず、未起動である事実を Q5 に残す
4. 評価エージェントはブラウザを使わない（証跡ファイルのみ分析）
5. 呼び出し側の義務（[契約](../_shared/reference/subagent-output-contract.md)より。文言はそのまま）:

   <!-- subagent-output-contract:body-return-checks -->
   - **本文を要求する（既定手順・スキップ不可）**: 起動しただけで本文が届くことを前提にしない。「並列起動 → 各エージェントへ本文を要求 → 逐語保存」の3ステップを踏む
   - **保存確認（スキップ不可）**: 逐語保存した本数分の実体を確認する。「上限に達して停止した」通知も完了として届くので、通知の種類で判断しない
   <!-- /subagent-output-contract:body-return-checks -->

   **実測では4体中4体が idle 通知だけを返し**、`SendMessage` で「所見の全文を最終メッセージ本文として返してください」と再要求して初めて返した。
6. **逐語保存（メインが実行）**: 各エージェントが返した本文を、**一字一句そのまま**上表の保存先（`.agent/evidence/<Issue番号>/qa/findings-*.md`）に Write する。**要約・並べ替え・見出しの付け替え・重要度の再判定を一切しない**（統合は Q5 で行う。ここは評価者の独立した所見をそのまま証跡化する工程）。再要求しても返らないエージェントがあれば、未返却を「指摘0件」と解釈せず、呼び出し側が代行評価するかその観点が欠落していることを成果物に明記する
7. 具体的には `ls .agent/evidence/<Issue番号>/qa/findings-*.md` で起動した本数分のファイルが揃っていることを確認する（overlay 無しなら3本。**4本を期待して待たない**）

### Q4.5. 追加探索（任意・最大1巡）
1. 各 findings の「追加探索依頼」を確認する
2. 依頼があれば、依頼内容をまとめて qa-explorer を**1回だけ**再起動し、証跡を追補する
3. 追補した証跡を該当の評価エージェントに渡して所見を更新する（2巡目以降は行わない）。更新後の所見も**本文で全文返させ**、メインが Q4 手順5と同じく該当 `findings-*.md` を逐語で上書き保存する

### Q5. QAレポートの作成
findings を統合し、`.agent/reports/qa-report-<Issue番号>.md` を作成する。重複指摘は1件に統合する（qa-ux-evaluator と overlay の QC レンズはユーザビリティ観点で重複しやすい）。**overlay を起動しなかった場合は「組織固有 QC レンズ ⏭ 未起動」の行を残す。**

```markdown
# QAレポート - Issue #<番号>（<機能名>）
実施日: YYYY-MM-DD / ブランチ: <名> / 証跡: .agent/evidence/<番号>/qa/
レビュー用動画: .agent/evidence/<番号>/qa/videos/（1ゴール1動画）

## 総合判定: 合格 | 条件付き合格 | 不合格
| 観点 | 判定 | Critical | Major | Minor |
|------|------|----------|-------|-------|
| ゴール到達性・導線 | OK/NG | 0 | 1 | 2 |
| 技術エラー（コンソール/ネットワーク） | | | | |
| UI/UX・レイアウト | | | | |
| 組織固有 QC（overlay。未起動なら ⏭ と書く） | | | | |

## ゴール達成状況
| ゴール | 到達 | 操作数 | 備考 |
|--------|------|--------|------|

## 指摘一覧
| # | 重要度 | 観点 | 指摘内容 | 証跡 | 再現手順 |
|---|--------|------|----------|------|----------|

## 良かった点（任意）

## /dev-fix への引き継ぎ
1. [Critical] <指摘内容>（分類候補: バグ / 証跡: <パス> / 再現: <手順>）
2. [Major] ...

実行例: `/dev-fix .agent/reports/qa-report-<番号>.md の指摘 #1,#2 を修正`
```

**総合判定の基準**:
- **合格**: Critical / Major なし
- **条件付き合格**: Major のみ（対応はユーザー判断）
- **不合格**: Critical あり

**重要度の定義**:
- **Critical**: ゴール到達不能 / データ破壊 / 5xxエラー / 機能しないレベルの画面崩れ
- **Major**: 回避策が必要な導線 / 恒常的なコンソールエラー・想定外の4xx / 明確なレイアウト崩れ
- **Minor**: 文言・配色・余白・軽微な分かりにくさ

### Q5.5. 変更理解ドキュメント生成（explain-diff）

QA 後はユーザーの成果物レビュー（ship 判断）が控えるため、**レビュー材料をこの時点で揃える**。

1. `.agent/explanations/` の最新 HTML の生成時刻（mtime）と最終コミット時刻を比較する
   - **HTML の方が新しい**（dev-verify D6.5 生成後にコミットが無い）→ 再利用。パス提示のみ
   - **HTML が古い or 無い** → `/explain-diff` を起動して生成（対象: `git diff origin/main..HEAD`）し、hub-run-add.mjs で実行マニフェストに追記（`--flow dev-qa`）
2. **実物確認**: エージェントが申告したパスを鵜呑みにせず、`ls .agent/explanations/` でディレクトリを列挙して生成物の実在を確認する（申告パスと実体が1文字違う場合がある。`test -f <申告パス>` だけで「未生成」と断定しない）
3. 生成に失敗してもフェーズを止めない

### Q6. ユーザー判断
1. QAレポートのサマリーをユーザーに提示する（Q5.5 の explain-diff HTML のパスを添える）
2. AskUserQuestion で対応方針を確認する:
   - **「Critical/Major を修正する」** → `/dev-fix` へ。レポートの「/dev-fix への引き継ぎ」セクションを修正希望として渡す
   - **「Minorのみ・このまま進む」** → Q7 へ
3. fix 完了後は再度 `/dev-qa` を実施する（再探索は指摘箇所の周辺に絞ってよい。証跡は `qa-2/` のように世代を分ける）

### Q7. 引継書更新 ⚠ 必須（スキップ不可）

> **注意**: このステップはQAフェーズの最終ステップであり、**ユーザーとのやり取りが途中で入っても必ず実行すること**。

1. `.agent/handover-YYYYMMDD-HHMM[-issue<番号>].md` として新規作成する
2. 含める内容:
   - 総合判定（合格 / 条件付き合格 / 不合格）
   - 指摘件数（Critical / Major / Minor）
   - QAレポートのパス（`.agent/reports/qa-report-<Issue番号>.md`）と証跡ディレクトリのパス
   - 未対応の指摘（ユーザーが「このまま進む」を選んだもの）
3. 次のアクションをユーザーに確認（正準順は verify → test-spec → qa → 台帳 → ship）:
   - **合格・条件付き合格**: 「QAが完了しました。/clear して `/dev-test-ledger`（統合モード）で自動＋手動のテストカバレッジを最終確認してから `/dev-ship` に進めますか？」（手動テスト仕様書があれば統合モードで🟣手動漏れまで確認できる。台帳確認後に ship へ）
   - **不合格（修正へ）**: 「/clear して修正フェーズ（/dev-fix）に進めますか？」

### Q7.5. 実行マニフェスト登録（推奨・スキップ可）

dev-hub の実行履歴ビューで QA 成果物を1セクションに束ねるため、`hub-run-add.mjs` で
証跡・レポート・動画を明示登録する。**動画（.webm/.mp4）はマニフェスト経由でのみ
dev-hub に表示される**ため、動画レビューを想定する場合は必須。レポート類は
`scanDocs.js` の自動スキャン対象だが、マニフェスト経由で登録すると同 run-id の
他成果物（explain-diff HTML 等）と1セクションに束ねられる。

```bash
node skills/_shared/scripts/hub-run-add.mjs \
  --repo <repoルート> \
  --run issue-<Issue番号> \
  --flow dev-qa \
  --issue <Issue番号> \
  --label "<機能名>" \
  .agent/reports/qa-report-<Issue番号>.md \
  .agent/evidence/<Issue番号>/qa/qa-brief.md \
  .agent/evidence/<Issue番号>/qa/findings-goal.md \
  .agent/evidence/<Issue番号>/qa/findings-technical.md \
  .agent/evidence/<Issue番号>/qa/findings-ux.md \
  .agent/evidence/<Issue番号>/qa/findings-overlay-qc.md \
  .agent/evidence/<Issue番号>/qa/exploration-log.md \
  .agent/evidence/<Issue番号>/qa/videos/*.webm
```

存在しないファイルは自動スキップ。Q5.5 で登録済みの explain-diff HTML と同じ run-id
なので、1開発サイクルの成果物が dev-hub で1セクションにまとまる。

> 再QA時（dev-fix 後の /dev-qa 再実行）は `qa-2/`, `qa-3/` の世代差分パスを同一
> run-id で追記する。hub-run-add は idempotent（同一パスの二重追記なし）なので
> 上書き心配は不要。

## ブラウザ競合の回避ルール

Playwright MCP のブラウザは**1セッション**である。複数エージェントが同時にブラウザを操作すると競合する。

1. ブラウザを操作するのは **qa-explorer のみ**（単独実行）
2. 評価エージェント4つには `mcp__playwright__*` ツールを**与えない**（証跡ファイルのみ分析）
3. qa-explorer 実行中はメインセッションもブラウザ操作を行わない

## 動画録画の前提（Playwright MCPの設定）

録画ツール（`browser_start_video` / `browser_stop_video`）は、Playwright MCP を **`--caps=devtools` 付きで起動した場合のみ**有効になる:

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest", "--caps=devtools"]
}
```

録画ツールが使えない環境では、qa-explorer は録画なしで探索を続行し、その旨をログに記録する（録画不可を理由にQAを中断しない）。動画は**人間のレビュー用**であり、評価エージェントの入力はスクリーンショット＋ログのみ。

## 証跡保存規約

```
.agent/evidence/<Issue番号>/qa/
├── qa-brief.md            # 入力（前提とゴール）
├── exploration-log.md     # 探索ログ（ステップ・操作・観察・対応スクショ）
├── console-messages.md    # コンソールログ全量
├── network-requests.md    # ネットワークログ（4xx/5xx抜粋を冒頭に）
├── screenshots/           # 連番-画面名.png
├── videos/                # レビュー用動画（G<ゴール番号>-<短い説明>.webm、1ゴール1動画）
├── findings-goal.md       # 評価所見（導線）
├── findings-technical.md  # 評価所見（技術）
├── findings-ux.md         # 評価所見（UI/UX）
└── findings-overlay-qc.md # 評価所見（組織固有 QC 観点。overlay がある環境のみ）
```

- `findings-*.md` は**メインセッションが逐語保存する**（評価エージェント自身は書けない。Q4 のハーネス制約を参照）。中身は評価者が返した本文そのままで、要約や統合を挟まない

- verify の証跡（`.agent/evidence/<Issue番号>/` 直下）とは `qa/` サブディレクトリで分離する
- 再QA時は `qa-2/`, `qa-3/` のように世代を分ける（qa-report からは最新世代を参照）

## verify との使い分け

| | /dev-verify | /dev-qa |
|---|---|---|
| タイミング | Phase単位（implement直後に毎回） | 全Phase完了後・ship前に1回 |
| 視点 | 仕様準拠（Issueどおりに動くか） | 利用者視点（初見で使えるか） |
| 手法 | E2Eテストコードの生成・実行 | 前提とゴールのみ渡す自律探索 |
| 成果物 | E2Eテストコード・テスト結果 | QAレポート（コード生成なし） |
