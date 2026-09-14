# advisor の扱いとコンテキストの区切り（advisor-policy）

dev-flow のサブエージェントに advisor をいつ呼ばせるかと、メインセッションをどこで `/clear` させるかの規約。どちらもトークン消費を減らすためのもので、判断の質を落とさない範囲に絞っている。

## なぜ置くか

ある利用環境の直近8日のログ（API 定価換算）を集計すると、次の2つが大きかった。

- **advisor が全体の23%**。うち約3割がサブエージェント・teammate からの呼び出しで、security-tester・adversarial-verifier・explain-diff-generator・test-writer・implementer・japanese-coding-specialist などが呼んでいた
- **メインセッションのコンテキストが 400K トークンに達した後のターンが、本体コストの41%**。1ターンの単価は 200K 未満の約2.6倍（$0.13 → $0.34）。dev-flow のメインセッションが teammate の報告を受け続けて 1M を超えた例もあった

advisor は、呼んだエージェント**自身の履歴全体**をキャッシュなしで advisor モデルに送る（実測で、サブエージェントの文脈量と advisor の入力量がほぼ一致した）。1回あたり6〜15万トークンになる。

## サブエージェントで advisor を止める手段は指示文しかない

- Claude Code の公式ドキュメントでは、サブエージェントは設定済みの advisor を継承する。サブエージェント単位で無効にする設定は無い
- エージェント定義の `tools` を絞っても止まらない（`tools` に advisor を含まない security-tester が実際に呼んでいた）
- `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` は全体停止で、メインセッションの advisor も止まる
- 公式の案内は「呼び出し頻度を変えたいなら指示文に書く」

**この指示文は効かない可能性がある。** advisor ツール自身のシステムプロンプトが「作業の前と完了前に呼べ」と強く促すので、エージェント本文の1文と競合する。効果はマージ後の呼び出し頻度（検証役エージェントの advisor 回数 ÷ リクエスト数）で測る。単発の実行では元々の頻度が低く（security-tester は219リクエストで5回）、0回でも効果の証拠にならない。

## 分類

エージェント定義は3つに分ける。表は `_shared/README.md` の「advisor の扱いの消費者」にあり、`agents/` の全ファイルを1回ずつ載せる（新しいエージェントを足したら、表に載せるまでテストが落ちる）。

| 分類 | 対象 | 理由 |
|---|---|---|
| reviewer | 検証・レビュー・評価・判定を役割とするもの | 役割そのものが検証なので、advisor は同じ観点の二重レビューになる |
| implementer | テスト・実装・デバッグを書くもの | 行き詰まったときの助言には価値がある。着手前・完了前の確認は、後段の検証役が担う |
| 制限なし | 要件・設計・技術選定・計画を担うもの | 方針の質が結果を決める作業で、advisor が本来想定する使い方 |

## 正準の文

消費側はマーカーの中を同じ文で持つ（`scripts/advisor-policy.test.js` が照合する）。

**reviewer**

<!-- advisor-policy:reviewer -->
- advisor ツールは呼ばない。このエージェントの役割そのものが検証であり、advisor を呼ぶと同じ観点の二重レビューになる。advisor にはこのエージェントの履歴全体がキャッシュなしで送られる
<!-- /advisor-policy:reviewer -->

**implementer**

<!-- advisor-policy:implementer -->
- advisor ツールは、同じエラーが2回続いて原因を特定できないときだけ呼ぶ。着手前・完了前の確認のためには呼ばない
<!-- /advisor-policy:implementer -->

エージェント定義の外から起動する経路（`general-purpose` での起動、組織側 overlay のエージェント）には、エージェント本文が届かない。その経路は起動プロンプトに reviewer の文を入れる。

## コンテキストの区切り

フェーズの最後に引継書を書いた直後が、`/clear` しても失うものがいちばん少ない。そこで `scripts/context-size.mjs` でメインセッションのコンテキスト量を測る。

<!-- advisor-policy:context-check -->
- 引継書を書いたら `node skills/_shared/scripts/context-size.mjs` でコンテキスト量を測る。`over` が `true` なら、次に進むかを尋ねる代わりに、測った `tokens` の値を示して「`/clear` してから次のコマンドを打ってください」と伝える。`tokens` が `null` なら `warning` をそのまま示し、従来どおり尋ねる
<!-- /advisor-policy:context-check -->

Claude は自分で `/clear` できない。自律的に回す `dev-loop` では、iteration の境界で `over` が `true` なら続行せず `halted-context` で止め、`/clear` → `/dev-loop resume` を案内する。続行すると、区切りの指示が無いのと同じになる。

`context-size.mjs` は `CLAUDE_CODE_SESSION_ID` から `<設定ディレクトリ>/projects/*/<id>.jsonl` を引き、サブエージェントの行（`isSidechain`）を除いた最後の応答の usage を足す。
