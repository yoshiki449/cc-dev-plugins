---
name: loop-review
description: ループ自体の効果検証・評価スキル（週次儀式、対話型）。dev-flow のループ群（dev-triage / dev-loop / auto-build / auto-feedback）が「役に立っているか」を評価する — ①価値計測（triage 指摘の対応率・有用性率・ループ発 commit の到達率）、②Debrief（halted run の原因4分類と最小変更提案、loopy 式）、③readiness 判定（loop-audit.sh の機械スコア＋意味情報で L1/L2/L3 の維持・昇格・降格・引退を推奨）。承認された Autonomy Level 変更だけ LOOP.md に反映する。ユーザーが「ループの効果を検証して」「ループを評価して」「loop review」「週次レビュー」「ループの振り返り」「昇格していい？」「このループ役に立ってる？」と言ったら起動する。ソースコードの変更・コミットは行わない（.agent/ 配下と承認済み LOOP.md 更新のみ）。
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, gh
---

# /loop-review - ループ効果検証・評価（週次儀式）

## 位置づけ

v0.9.0 のメトリクス（loop-metrics.sh）が「**安全に動いているか**」を見るのに対し、本スキルは「**役に立っているか**」を評価する。loopy の Debrief（原因診断）と loop-engineering の loop-audit（readiness スコアと昇格ゲート）の合成。

**対話型・手動実行前提**（crontab に入れない）。価値ラベリングと昇格承認に人間の回答が必要なため。週1回、または dev-triage が「前回 loop-review から14日超」と警告したときに実行する。

## 引数

```
/loop-review            # 既定（直近7日を評価）
/loop-review days=14    # 期間指定（初回や間が空いたときは 14〜28 を推奨）
```

## 手順

### R0. 前提

1. `bash skills/_shared/scripts/ensure-loop-files.sh` を実行
2. STATE.md の Run Log から前回 loop-review の日付を取得。14日以上前（または初回）なら `days=14` 以上を提案してから進む
3. 評価期間をユーザーに提示（例:「2026-06-29 〜 07-06 の 7 日間を評価します」）

### R1. データ収集（読み取りのみ）

以下を並行して集める:

1. `.agent/STATE.md` の Run Log（期間内の行）と Open Items
2. `bash skills/_shared/scripts/loop-metrics.sh <root> <days>` の出力（安全性メトリクス）
3. `bash skills/_shared/scripts/loop-audit.sh <root> <days>` の出力（readiness 機械スコア）
4. 期間内の証拠ファイル: `.agent/triage-*.md`／`.agent/devloop-*.md`／`.agent/autopilot/*/state.md`・`inbox/*`／`.agent/loop-review-*.md`（前回分）
5. `git log --since=<期間> --oneline` と `gh pr list --state all --limit 20`（ループ発 commit の行方の判定材料）

### R2. 価値計測

**(a) triage 指摘の対応率**

1. 期間内の `triage-*.md` から P1 / P2 項目をすべて列挙する
2. **機械的に検証できる項目は自動判定**する（例:「未 push commit」→ 現在 push 済みか、「未コミット変更」→ clean か、「滞留 Issue」→ クローズ or 更新されたか）
3. 自動判定できなかった項目は **AskUserQuestion（multiSelect）でまとめて確認**: 各項目に「対応した／意図的に見送った／無視していた（忘れていた）」
4. **有用性率 = (対応した ＋ 意図的見送り) ÷ 全指摘**。「無視していた」は指摘が届いていない（S/N 比の悪化）とみなし、多い指摘種別は改善候補に挙げる

**(b) ループ発 commit の到達率**

Run Log で commits > 0 の run について、その commit 群が現在「マージ済み／PR レビュー中／どこにも届いていない（放置ブランチ）」のどれかを git/gh で判定し、到達率を出す。

**(c) コスト対価値の所見**

loop-metrics.sh の token 概算と (a)(b) を並べ、「2週連続でコスト > 価値」（LOOP.md の引退基準）に該当しそうなループがあれば明示する。

### R3. Debrief（loopy 式、halted run の原因診断）

`reference/debrief-template.md` を Read し、その型と規律に**厳密に**従う。

- 対象: 期間内の halted-* run（対応表参照）と「stop-judge done=false のまま強制完了」した run
- 1 run ごとに Verdict（原因4分類）／Evidence（進捗ファイル・inbox からの**具体引用必須**）／Diagnosis／Recommended change（**最小変更1つ**）
- 規律（テンプレートの禁止事項4点）: 単一 run からパターン主張しない／環境障害をプロンプト改修に転換しない／証拠不足は「結論不可」／改善案は1つに絞る
- 対象 run がゼロなら「Debrief 対象なし（健全）」と1行書く

### R4. readiness 判定（維持／昇格／降格／引退）

loop-audit.sh の機械スコアに R2/R3 の意味情報を合成し、**ループごと**に判定する:

| 判定 | 条件の目安 |
|---|---|
| **昇格推奨**（L1→L2、L2→L3） | 機械スコアのレベル目安 ✓ ＋ 有用性率 70% 以上 ＋ Debrief で「①ループ設計」起因の halt がない ＋ **期間内 run 数 5 以上** |
| **維持** | 上記に満たないが問題もない（既定） |
| **降格推奨**（L3→L2、L2→L1） | 誤 halt 率 30% 超が未解消／「①ループ設計」起因の halt が 2 run 以上／有用性率 40% 未満 |
| **引退推奨** | 2週連続でコスト > 価値（R2(c)）／runs はあるが「無視していた」が大半 |

**ガード（重要）**: 期間内 run 数が **5 未満**のループには昇格推奨を出さない（データ不足。機械スコアが満点でも「維持（データ蓄積中）」とする）。これは「単一 run からパターンを主張しない」規律の昇格版。

### R5. レポート出力

`.agent/loop-review-<YYYYMMDD>.md` に以下の構成で出力:

```markdown
# Loop Review — YYYY-MM-DD（期間: X日）

## サマリ
（runs 数、有用性率、到達率、Debrief 件数、推奨変更の有無を3-5行で）

## 価値指標
（R2 の (a)(b)(c)。ラベリング内訳も記録 — 次回比較の基準になる）

## Debrief
（R3 の全 Debrief。対象なしならその旨）

## readiness スコア
（loop-audit.sh の出力をそのまま貼る）

## ループ別判定
| loop | 期間内 runs | 判定 | 根拠 |
|---|---|---|---|

## 改善候補（Recommended changes 一覧）
（R3 の最小変更を集約。実施は /dev-fix 等へ）
```

STATE.md の Run Log に1行 append:
`| <YYYY-MM-DD HH:MM> | loop-review | report | 1 | 0 | <概算token> | report-done | 有用性率:X% 推奨:N件 |`

### R6. 昇格承認と反映（人間ゲート）

1. R4 で「維持」以外の推奨があるループについてのみ、AskUserQuestion で1問ずつ提示（根拠を本文に転載: スコア・有用性率・Debrief 所見）
   - 選択肢: 「承認（反映する）」／「見送り（現状維持）」
2. **承認されたものだけ** `.agent/LOOP.md` の Autonomy Level 表を Edit で更新し、備考列に `YYYY-MM-DD loop-review により変更（<根拠1行>）` を追記
3. 引退が承認された場合: LOOP.md の該当行を更新し、STATE.md の運用メモに `- <loop名>: status: retired（YYYY-MM-DD、<理由>）` を記録
4. R3 の Recommended change（supervisor プロンプト調整・しきい値変更等）は **このスキルでは実施しない**。ループ定義の変更は **`/loop-improve`（変更→実測→won/lost/tie 判定つき）** へ、対象プロジェクト側のコード修正は `/dev-fix` へ、と明示的に引き継ぐ
5. 推奨がすべて「維持」なら LOOP.md には**一切触らない**

### R7. 最終報告

- 有用性率・到達率・判定一覧・承認結果を要約
- レポートファイルのパス
- 次回実施の目安（7日後。dev-triage が14日超で警告することも案内）

## 禁止事項

- ソースコードの Write / Edit / commit / push（書いてよいのは `.agent/` 配下のレポート・STATE.md・**承認済みの** LOOP.md 更新のみ）
- 承認なしの Autonomy Level 変更
- run 数 5 未満のループへの昇格推奨（データ不足）
- Debrief 規律違反（単一 run のパターン化・環境障害のプロンプト転換・引用なし Verdict）

## 関連

- `reference/debrief-template.md` — Debrief の型・原因4分類・停止条件対応表
- `skills/_shared/scripts/loop-audit.sh` — readiness 機械スコア
- `skills/_shared/scripts/loop-metrics.sh` — 安全性メトリクス（R1 で併用）
- `/dev-triage` — 日次の発見係（本スキルは週次の評価係。triage が14日超未実施を警告する）
