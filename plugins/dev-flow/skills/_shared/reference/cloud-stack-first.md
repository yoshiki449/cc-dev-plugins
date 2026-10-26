# クラウドでの実スタック確認（cloud-stack-first）

クラウドセッション（`CLAUDE_CODE_REMOTE=true`）で、検証フェーズ（dev-verify）と QA フェーズ（dev-qa）が「実スタックを立てられない」と判断する前に、必ず `cloud-stack` を実行させるための規約。

## なぜ置くか

実測で、次の連鎖が起きた。

1. dev-verify が「docker デーモンも DB も無い」と引継書に書いた。実スタックを立てる操作は試していなかった
2. 次の dev-qa が、その記述を確かめずに採用し、「ローカルに持ち越し」と案内した
3. ユーザーに指摘されて `cloud-stack.sh up` を実行すると、docker は入っていて、dockerd も起動し、8 サービスのスタックが立った

引継書の「無い」は、書いた側が測った結果とは限らない。クラウドの docker は、使うときに `cloud-stack` が起こすので、`docker info` が通らないことは「無い」の証拠にならない。

## 正準の文

消費側はマーカーの中を同じ文で持つ（`scripts/cloud-stack-first.test.js` が照合する）。

<!-- cloud-stack-first -->
- `CLAUDE_CODE_REMOTE=true`（クラウドセッション）では、実スタックを「立てられない」と判断する前に、`bash <skill-dir>/../cloud-stack/scripts/cloud-stack.sh status <repo>` で状態を見て、立っていなければ同 `up <repo> --wait` を実行する。引継書や記憶にある「docker が無い」「DB が無い」は写さず、この実行結果（成功したか、失敗ならログ末尾）を根拠にする。実行して失敗したときだけ、実行したコマンドと失敗の出力を添えて未実施として記録する。`cloud-stack.sh list` に出ないリポジトリ（`.claude/cloud-stack.json` が無い）は対象外
<!-- /cloud-stack-first -->

## 消費者

表は `_shared/README.md` の「クラウドでの実スタック確認の消費者」にある。新しい消費者を足したら、表にも足すこと。
