# dev-implement のゲート判定: 理由と設計経緯

SKILL.md の実行手順から外した説明。手順は SKILL.md、ここは「なぜそうなっているか」。

## 判定対象は「ブランチの累積差分」

判定器は常に `main...HEAD` を見る。したがって **Phase が進むほど `lines` は増え、後半 Phase は
その Phase 自体が小さくてもレンズが増える**。これは仕様であり、fail-safe（重い側に倒れる）方向。

- Phase ごとの `--base` を発明して差分を切り出すと、判定を1箇所に集中させる契約
  （`assess-change-size.sh` が唯一の判定器）が壊れ、implement と ship で判定がズレる
- レンズが増えるのは「積み上がった変更を後半ほど厚く見る」ことなので、意図に沿っている

### 既知の制約 — 装備は一方向にしか動かない

累積が閾値をまたいだ時点から先は、その Phase 自体がどれだけ小さくても二度と軽くならない
（`main...HEAD` は縮まないため）。「Phase 5 は10行だけなのにレンズ3本」は不具合ではなく仕様。
軽い側へ戻す仕組みは意図的に持たせていない（戻せるようにすると、大きな変更の後に
小さな Phase を挟むだけでレビューを軽くできてしまう）。
Phase 単位ゲートと ship 単位の累積ゲートを分ける仕組みは持たない。

## `/dev-loop` 経由では Code-Reviewer を Phase 毎に維持する

Code-Reviewer を ship に集約すると「Phase 途中での早期レビュー発見」が弱まり、その代替を
「`/dev-loop` 利用時は Phase 毎の Code-Reviewer を維持する」としている。dev-loop は
ユーザーの確認を挟まず iteration を回すため、ship まで品質観点を持ち越すと
**誤りが積み上がった状態でしか止まらない**。

レンズ本数（`adversarial_lenses`）は dev-loop 経由でも判定どおりに従ってよい。
両者を分ける根拠は「その検証が何をゲートしているか」が違うこと:

| | ゲートしているもの | dev-loop で削ると何が起きるか |
|---|---|---|
| Code-Reviewer | **次の iteration に進んでよいか**（実装の妥当性） | 誤った実装の上に次の iteration が積まれ、巻き戻し幅が iteration 数に比例して膨らむ |
| レンズ B/C | **そのサイクルのテストが十分か**（テストの網羅） | 穴は残るが後続 iteration は影響を受けない。ship の判定は累積差分なので、積み上がってサイズが上がれば ship 側で B/C 相当の観点が改めて発火する |

Code-Reviewer の欠落は複利で悪化するが、レンズの欠落はその場に留まり後で回収される。
この非対称性が carve-out を Code-Reviewer だけに限る理由。
（静的な理屈であって実測ではない。dev-loop を S 判定で回した実績が貯まったら見直すこと）

## 「集約」が「脱落」にならないための前提

`"ship"` を選べるのは、**ship 側で `dev-flow:Code-Reviewer` が必ず走るから**である。
`gates.self_review_members` は S・M・L のすべてに `dev-flow:Code-Reviewer` を含む
（`_shared/scripts/assess-change-size.sh` の `SELF_REVIEW_S` と `SELF_REVIEW_S_SELF_VERIFYING`。テスト `AC28` / `AC70` が固定している）。

`dev-self-review` の S の顔ぶれから Code-Reviewer を外すと、バグ・エラーハンドリング・入力検証を見る
agent が dev-flow 全体から消える。

`dev-flow:simplify-reviewer` は受け皿にならない。禁止事項で「バグ・セキュリティの指摘」を
明示的に除外しているため（`agents/simplify-reviewer.md` の禁止事項節）。
simplify-reviewer を受け皿にした設計はセルフレビューでこの矛盾が実測されたため、S の3本目は Code-Reviewer にしている。

## 旧 tdd-implementer

旧バージョンでは `tdd-implementer` 1 エージェントが RED→GREEN→REFACTOR を全て担当していたが、
**自分が書いたテストに自分の実装を合わせる echo chamber** リスクがあるため、3分割を標準とした。
