# cc-dev-plugins

Claude Code の **plugin marketplace**。開発フローを回すための skills / commands / agents / hooks を
カテゴリ別の plugin として束ねている。

## 入れ方

```
/plugin marketplace add <このリポジトリの URL>
/plugin install dev-flow@cc-dev-plugins
/reload-plugins
```

## 何が入っているか

| plugin | 何をするか |
|---|---|
| **dev-flow** | 開発フロー一式。`/dev` ルーターから plan → setup → implement → verify → qa → ship の各フェーズへ入る。半自律ループ `dev-loop`、完全自律の `auto-*`、成果物を1画面で見る `dev-hub`、変更理解ドキュメントを作る `explain-diff` を含む |
| **poc-flow** | 試作・実現性検証だけの軽量フロー。品質ゲートをブラウザ実機スモーク1本に絞り、自動テストとコードレビューを行わない。本採用が決まった時点で dev-flow に合流する |
| **cc-meta** | この marketplace 自身の管理。ローカルのスキルを plugin へ移植する `/promote-skill` など |
| **git-secret-guard** | `git push` の直前に、秘密の値と公開してはいけない固有名を走査して止める |

## 設計の考えかた

この3つが全体を貫いている。

**ゲートは無音で死なせない。** 検査が「実行されなかった」ことと「検査して問題が無かった」ことを
区別できる形にする。判定器は判定できなかったときに重い側へ倒し、必ず警告を出す。
起動しなかったレビューは報告から消さず `⏭` で残す。消すと、軽い経路を通ったことが
後から監査できなくなる。

**実行コストを変更の大きさとリスクに連動させる。** 10行の修正に最重量のレビューを掛けると、
誰も通らなくなって結局ゲートが死ぬ。`assess-change-size.sh` が変更規模（S / M / L）と
リスク（LOW / HIGH）を独立に判定し、起動するレビューの本数を決める。1軸に畳まないのは、
畳むと小さい変更が常に重くなるため。

**組織固有の品質基準は同梱しない。** 会社ごとの QC チェックリストは overlay として
`~/.cc-plugins/overlay/qc/` から差し込む。overlay が無くても全フェーズが動き、
観点が1件も適用されなかったことを必ず報告する。契約は
`plugins/dev-flow/skills/_shared/reference/qc-overlay.md`。

## テストの方針

スクリプトと判定器には `node --test` のテストが付いている。

```bash
node --test $(git ls-files | grep -E '\.test\.(js|mjs)$' | grep -v '/fixtures/')
```

`fixtures/` を外すのは、あそこに置いてあるのが **vitest 用**のテストで、`node --test` では原理的に読めないため
（`loop-eval` が fixture アプリ上で実走させる。動かすなら fixture ディレクトリで `npm ci` してから vitest で回す）。

**緑だけでは検証にならない。** 「正しいから通った」と「何も検証していないから通った」は
緑では区別できないので、守りたい実装をわざと壊してテストが落ちることを実測してから
「テストした」と言う。ドキュメントを検査するテストでは、語の存在ではなく**挙動を決めている
行そのもの**を固定する（語の存在チェックは、指示を反転しても通ってしまう）。

## Issue 番号について

コード・コメント・ドキュメントに出てくる `#数字` や `Issue #数字` は、公開前に使っていた非公開リポジトリの番号で、
このリポジトリの Issue とは対応しない。移管した Issue には本文の末尾に旧番号を書いてある。
