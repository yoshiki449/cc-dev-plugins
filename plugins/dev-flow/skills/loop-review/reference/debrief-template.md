# Debrief テンプレート（loopy 式）

`/loop-review` の R3 で、期間内の halted-* run（および stop-judge done=false のまま強制完了した run）1件ごとにこの型で診断する。

## 出力型

```markdown
### Debrief: <run 日時> <loop名> — <final_status>

- **Verdict**: ①ループ設計 | ②実行時の選択 | ③環境・ツール障害 | ④ゴール側の問題 | 結論不可
- **Evidence**: <進捗ファイル・inbox・state.md からの具体引用。引用なしの Verdict は無効>
- **Diagnosis**: <なぜこの終了状態になったか、1-3文>
- **Recommended change**: <最小変更1つ（観測・ルール・チェック条件・停止・承認境界のいずれか）。不要なら「No loop change needed」>
```

## 原因4分類の判定ガイド

| Verdict | 意味 | dev-flow での典型例 |
|---|---|---|
| ①ループ設計 | ループの観測・判定・停止の設計自体に欠陥 | supervisor の誤 halt（halt=過剰）が続く／thrashing ハッシュが意味的に同じ findings を検知できず空回り／stop-judge の G 基準がプロジェクト実態と合わない |
| ②実行時の選択 | 設計は正しいが、その run での判断ミス | findings 分類を誤って fix を implement に流した／FixPlan の files_to_change 宣言が狭すぎて scope-drift 誤検知を誘発／report-only で始めるべき案件を通常モードで起動 |
| ③環境・ツール障害 | ループ外の環境要因 | Playwright MCP 起動失敗／DB・ローカルサーバー停止／gh 認証切れ／StructuredOutput 失敗の連発 |
| ④ゴール側の問題 | ゴール自体が非現実的 or 途中で変わった | Issue の受け入れ基準が曖昧で stop-judge が done にできない／レビュー途中で要件が変わり FeedbackItems が古い |

## 規律（禁止事項）

1. **単一 run からパターンを主張しない**: 「〜する傾向がある」「いつも〜」は同種の証拠が **2 run 以上** あるときだけ。1 run しかなければ「この run では」と書く
2. **環境障害をプロンプト改修に転換しない**: Verdict=③ のとき、Recommended change はループ側の変更ではなく環境の修復（または pre-flight チェックへの追加）に限る。検証なしに「プロンプトを強くする」で対処しない
3. **証拠不足なら結論不可**: 進捗ファイル・inbox に判断材料が無ければ Verdict=結論不可 とし、「次回この診断を可能にするために何を記録すべきか」を Recommended change に書く
4. **最小変更1つ**: 複数の改善案を並べない。最も確度の高い1つに絞る（大規模改変より微調整を優先）

## final_status → loopy 6停止条件の対応表

| dev-flow final_status | loopy 停止条件 | Debrief 対象 |
|---|---|---|
| done / all-green | Success | 不要（R2 の価値計測のみ） |
| report-done / report-only | Clean no-op | 不要 |
| halted-error | Blocked | 対象 |
| halted-checkpoint | Approval required | 対象 |
| halted-iter / halted-commits / halted-commits-per-iter / halted-runtime / halted-attempts / halted-budget / halted-token-per-attempt | Exhausted | 対象 |
| halted-thrashing | No progress | 対象 |
| halted-supervisor | No progress または Blocked（reason 次第） | 対象 |
| halted-denylist | Approval required | 対象 |
| halted-user / halted-superseded | （人間都合の中断） | 原則不要（頻発時のみ対象） |
| stop-judge done=false のまま強制完了 | Success 扱いだが証拠不足 | 対象（G 基準とゴールの乖離を診断） |
