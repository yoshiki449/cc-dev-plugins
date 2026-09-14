---
name: loop-improve
description: dev-flow のループ定義（loop-supervisor / stop-judge のプロンプト・しきい値・SKILL.md の手順）を、測定に裏付けて改善する。/loop-review の改善提案や /loop-eval の FAIL シナリオを入力に、変更を1つだけブランチに適用し、/loop-eval の before/after 比較で勝ったものだけを人間の承認を経て main にマージする。ユーザーが「ループを改善して」「supervisor のプロンプトを直して効果を測って」「loop-improve」「Debrief の改善案を反映して」「測定つきで直して」と言ったら起動する。**測定なしの merge は禁止**。dev-flow plugin のソースリポジトリ内で実行する。
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, gh
---

# /loop-improve - 測定裏付き改善（maker/checker）

## 位置づけ

「Debrief が改善案を出す → 人間が手で直す」の最後の輪を閉じる。**変更 → 実測 → 数値で採否** のサイクルで、感覚による改悪（プロンプトいじり）を防ぐ。

```
入力（loop-review の Recommended change / loop-eval の FAIL）
  → I1 ブランチに変更1つ適用
  → I2/I3 before・after を /loop-eval で実測（同一シナリオ・同一 runs）
  → I4 won / lost / tie 判定
  → I5 won ＋ 人間承認 → merge。それ以外 → ブランチ破棄（記録は残す）
```

## 前提

- dev-flow を持つ marketplace リポジトリ（このリポジトリ）で実行する
- working tree が clean であること
- 改善対象は **ループ定義ファイルのみ**: `agents/loop-supervisor.md`・`agents/stop-judge.md`・`skills/dev-loop/SKILL.md`・`workflows/*.workflow.js` のしきい値・`fixtures/scenarios/*.json`（eval 自体の改善）等

## 手順

### I0. 対象選定（変更は1つだけ）

1. 入力源を確認: `.agent/loop-review-*.md` の「改善候補」／ `.agent/loop-eval/*/benchmark.md` の FAIL シナリオ／ユーザーの直接指示
2. 候補が複数あるときは AskUserQuestion で **1つ**選ぶ（複数同時変更は効果の帰属が壊れるため禁止）
3. 効果を測定できるシナリオを特定する（例: supervisor の誤 halt 対策 → devloop-normal ＋ trap 系。**変更が改善するはずのシナリオと、劣化してはいけないシナリオの両方**を選ぶ）
4. 測定計画（シナリオ × runs × 概算コスト）を提示し AskUserQuestion で承認

### I1. ブランチと変更適用

1. `git checkout -b improve/<対象>-<YYYYMMDD>`
2. 選んだ変更を**最小差分**で適用（Debrief の Recommended change に忠実に。ついで修正禁止）
3. 変更内容の diff をユーザーに提示

### I2. before 測定（current）

- `.agent/loop-eval/` に**同一シナリオ・同一 runs の直近結果（7日以内）があれば再利用**してコスト節約（manifest.json の scenario / label=current で照合）
- 無ければ `main` の状態で `/loop-eval scenario=<id> runs=<N> label=current` を実行（ブランチ上でも plugin_dir 未指定なら installed 版 = current が走る点に注意。確実にするなら `git stash` 不要の worktree で main を参照）

### I3. after 測定（candidate）

`/loop-eval scenario=<id> runs=<N> label=candidate plugin_dir=<dev-flow のソースリポジトリ>/plugins/dev-flow` を**同じ結果ディレクトリ**に対して実行（ブランチの dev-flow を `--plugin-dir` で読み込ませる）。

> `--plugin-dir` で candidate 版が反映されない場合のフォールバック: `/plugin marketplace update` で一時的にローカルブランチを反映 → 測定 → main に戻して再 update。この場合は測定中に他セッションが candidate 版を掴む可能性があることをユーザーに伝える。

### I4. 比較と判定

`aggregate_loop_eval.py` の Delta（current → candidate）で判定:

| 判定 | 条件 |
|---|---|
| **won** | pass_rate の mean が改善（+0.05 以上）。同点なら cost / iterations の改善で判定 |
| **tie** | pass_rate 差が ±0.05 未満かつ cost 差も僅少 |
| **lost** | pass_rate が悪化、または改善対象外シナリオが劣化（回帰） |

runs=1 同士の比較は信頼性が低い — won 判定を出すには **runs≥2** を推奨（1 run 差は tie 寄りに倒す）。

### I5. 採否（人間ゲート）

- **won**: benchmark.md と diff を提示し、AskUserQuestion で merge 承認を得る → 承認されたら `git checkout main && git merge --no-ff improve/... `、コミットメッセージに Issue 番号、version bump（patch: プロンプト調整 / minor: 手順変更）を提案、push
- **lost / tie**: ブランチを削除（`git branch -D`）。**採用しない**。ただし結果は I6 で必ず記録
- 承認されなかった won も同様にブランチ削除

### I6. 系譜記録（history.json）

`.agent/loop-eval/history.json` に追記（skill-creator 互換の考え方）:

```json
{
  "entries": [
    {
      "id": "improve/supervisor-drift-20260713",
      "date": "2026-07-13",
      "target": "agents/loop-supervisor.md",
      "change_summary": "<1行>",
      "scenarios": ["devloop-normal", "devloop-trap-impossible"],
      "runs": 2,
      "result": "won | lost | tie",
      "delta_pass_rate": "+0.2",
      "merged": true,
      "benchmark_path": ".agent/loop-eval/<ts>/benchmark.md"
    }
  ]
}
```

STATE.md の Run Log にも1行 append: `| <日時> | loop-improve | <対象> | 1 | <commits> | cost:$<実測> | <won|lost|tie> | merged:<true|false> |`

## 禁止事項

- **測定なしの merge**（どんなに自明に見える改善でも before/after を取る）
- 複数変更の同時適用
- lost / tie の採用（「気持ち的には良くなったはず」禁止）
- 改善対象シナリオだけ測って回帰シナリオを測らないこと
- fixture の assertions を「PASS しやすいように」弱める改変（eval の改善は grader の eval_feedback を根拠に、独立の変更として行う）

## 関連

- `/loop-eval` — 測定の実体
- `/loop-review` — 改善候補の主要な入力源（R3 Debrief の Recommended change）
- `.agent/loop-eval/history.json` — 改善の系譜（won/lost/tie）
