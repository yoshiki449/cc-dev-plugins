---
name: loop-eval
description: dev-flow のループ（dev-loop / auto-build 等）を **fixture 上で実際に走らせて**効果測定するスキル（skill-creator の eval/benchmark 相当）。隔離 sandbox に fixture アプリをコピーし、headless claude -p（コスト上限つき）でループを実走 → loop-eval-grader が assertion 単位で PASS/FAIL 採点 → benchmark として集計する。トラップシナリオ（denylist 抵触・達成不能ゴール）で「止まるべき時に止まるか」も検証できる。ユーザーが「ループを実走して評価して」「ループの eval を回して」「loop-eval」「ベンチマークを取って」「ガードが効くか実測して」「トラップシナリオを試して」と言ったら起動する。**実 API コストが発生するため、実行前に必ず見積りを提示して承認を得る**。
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Grep, Glob, Agent
---

# /loop-eval - ループの実走評価（eval / benchmark）

## 位置づけ

| スキル | 評価方式 |
|---|---|
| `/loop-review` | 過去の実運用 run の**観察**（受動・低コスト） |
| **`/loop-eval`（本スキル）** | fixture 上でループを**実走**させる測定（能動・実コスト発生） |
| `/loop-improve` | 本スキルの before/after 比較で改善を採否判定 |

## 引数

```
/loop-eval                          # tier=smoke（配管検証、最安）
/loop-eval tier=standard            # dev-loop 正常系＋トラップ2種
/loop-eval tier=full                # auto-build 実走込み、runs=3（variance 分析）
/loop-eval scenario=devloop-normal  # 単一シナリオ指定
/loop-eval scenario=devloop-normal runs=3
/loop-eval label=candidate plugin_dir=<dir>   # loop-improve 用（candidate 版で測定）
```

- `tier`: smoke（smoke-* 2本）/ standard（devloop-normal ＋ trap 2本）/ full（standard ＋ autobuild-normal）
- `runs`: シナリオあたりの実行回数。既定 1（full のみ既定 3 = skill-creator の runs_per_configuration 踏襲）
- `label`: config 名（既定 `current`）。結果ディレクトリの第1階層になる
- シナリオ定義: `<plugin>/fixtures/scenarios/*.json`、fixture: `<plugin>/fixtures/loop-eval-app/`

## 手順

### E0. 前提とコスト承認（必須）

1. fixture の存在と `npm` を確認。full tier は Playwright（`~/.cache/ms-playwright`）と `@playwright/mcp` の利用可否も確認
2. 対象シナリオ一覧と **総コスト見積り = Σ(シナリオの budget_usd × runs)** を提示し、**AskUserQuestion で承認を得る**（これが唯一の実行ゲート。承認なしに headless 実行を始めない）
3. 結果ディレクトリを決定: `.agent/loop-eval/<YYYYMMDD-HHMM>/`（loop-improve からの呼び出し時は指定された既存ディレクトリに config を追加）

### E1. 実走（シナリオ × runs）

各シナリオ・各 run について runner を実行する:

```bash
bash skills/_shared/scripts/loop-eval-run.sh \
  <plugin>/fixtures/scenarios/<id>.json \
  .agent/loop-eval/<ts>/<label>/<id>/run-<N> \
  --label <label> [--budget-usd <上書き>] [--plugin-dir <candidate版>]
```

- runner は sandbox 準備 → headless 実行（`--max-budget-usd` ハードキャップ・タイムアウト90分）→ 成果物収集まで行う。**ループが halted で終わっても runner は正常終了**（それを採点するのが grader）
- 実行は**シナリオ単位で直列**（fixture サーバーのポート競合と負荷を避ける）。長いので進捗を都度ユーザーに報告する
- runner が exit 1（セットアップ失敗）の場合はその run を `setup-failed` として記録し、残りを続行

### E2. 採点（loop-eval-grader）

各 run について `Agent({ subagent_type: "dev-flow:loop-eval-grader" })` を起動し、run ディレクトリのパスを渡す。grader が `grading.json` を run ディレクトリに書く。複数 run の採点は並列起動してよい。

### E3. 集計

```bash
python3 skills/_shared/scripts/aggregate_loop_eval.py .agent/loop-eval/<ts>/
```

`benchmark.json` / `benchmark.md` が生成される。`runs >= 3` の場合は追加で variance 所見を分析する（skill-creator の analyzer 観点）:
- 全 config で常に PASS する assertion（= 差別化しない、削除候補）
- 常に FAIL する assertion（= 壊れているか能力外）
- 高分散（run によって PASS/FAIL が割れる = flaky）なシナリオ・assertion

### E4. レポートと記録

1. `benchmark.md` ＋ FAIL した assertion の一覧（evidence 付き）＋ variance 所見 ＋ **実測コスト合計**（metrics.json の total_cost_usd 集計）をユーザーに提示
2. grader の `eval_feedback` から assertion/シナリオ自体の改善候補があれば添える
3. STATE.md の Run Log に1行 append:
   `| <日時> | loop-eval | <tier or scenario> | <総run数> | 0 | cost:$<実測合計> | report-done | pass_rate:<平均>% |`
4. FAIL があれば次アクションとして `/loop-improve` を案内

## コストの目安（初回実走後に実測で更新すること）

| tier | シナリオ × runs | budget cap 合計 |
|---|---|---|
| smoke | 2 × 1 | 〜$6 |
| standard | 3 × 1 | 〜$30 |
| full | 4 × 3 | 〜$165 |

cap は「上限」であり通常は下回る。実測が出たらこの表を更新する。

## 禁止事項

- **承認前の headless 実行**（E0 の AskUserQuestion が唯一のゲート）
- budget cap の無断引き上げ（シナリオ定義の budget_usd を超える場合は都度承認）
- fixture・cc-plugins 本体・sandbox 外への変更（書いてよいのは `.agent/loop-eval/` と STATE.md のみ）
- grader を通さない「実行ログの目視だけ」での合否判定

## 関連

- `fixtures/scenarios/*.json` — シナリオ定義（assertions を追加・修正したら grader の eval_feedback と突き合わせる）
- `agents/loop-eval-grader.md` — 採点者（疑わしきは FAIL）
- `/loop-improve` — 本スキルの before/after 比較で改善を採否判定
