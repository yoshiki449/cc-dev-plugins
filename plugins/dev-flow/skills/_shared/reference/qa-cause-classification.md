# dev-qa「起因」判定基準

`qa-goal-evaluator` / `qa-technical-evaluator` / `qa-ux-evaluator` の3エージェントが指摘一覧に付ける「起因」列（`今回の変更` / `既存` / `不明`）の判定基準。差分レビューでは拾えない「既存」の指摘こそが dev-qa の価値（`feedback_diff_review_blindspot`）なので、**起因は表示区分に留め、重要度の判定基準・総合判定には一切使わない**。

正準文（3エージェントの起動プロンプトへ**そのまま埋め込む**必要があり、実行時に他ファイルを読めないため、各エージェント定義に複製で置いている。落ちる方向を誤らないこと: 正準側だけ強化して消費側が古いままだと、実際にエージェントへ渡るのは古い方なので改善が一切効かない）:

<!-- qa-cause-classification:rule -->
「起因」は QAブリーフの「変更範囲」と照合し、`今回の変更` / `既存` / `不明` のいずれかを記載する。判定できなければ `不明`。**重要度の判定基準には影響させない**
<!-- /qa-cause-classification:rule -->

各エージェントはこの正準文の直後に、担当観点に応じた具体例を括弧書きで続けてよい（例: 「既存の導線不備も同じ基準で Critical/Major/Minor を付ける」）。**マーカーで囲んだ部分は3ファイルで byte-identical** でなければならない（`qa-cause-classification.test.js` が検証する）。

## 消費者

| エージェント | ファイル |
|---|---|
| qa-goal-evaluator | `plugins/dev-flow/agents/qa-goal-evaluator.md` |
| qa-technical-evaluator | `plugins/dev-flow/agents/qa-technical-evaluator.md` |
| qa-ux-evaluator | `plugins/dev-flow/agents/qa-ux-evaluator.md` |

`dev-qa/SKILL.md` の QAレポート「指摘一覧」節にも同趣旨の注記があるが、こちらはメインセッションが読む手順書であり起動プロンプトへの埋め込み制約が無いため、マーカーでの複製対象にはしていない（表現は独立でよいが、趣旨＝「表示区分であり重要度・総合判定には使わない」は一致させること）。
