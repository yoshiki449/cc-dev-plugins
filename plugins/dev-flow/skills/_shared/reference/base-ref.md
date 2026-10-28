# 差分の比較元（base）の決め方

dev-flow の差分は `main...HEAD` のように起点を直書きしない。統合ブランチが `develop` のリポジトリや、
ローカルの `main` が `origin/main` より古い worktree 運用で、無関係な変更が台帳・レビュー・規模判定に
静かに混ざるため（差分は取れてしまうので、出力を見ても気づけない）。比較元は共通ヘルパー
`resolve-base-ref.sh` が1本で決め、この文書では `<BASE>` と書く。

```bash
bash <skill-dir>/../_shared/scripts/resolve-base-ref.sh --dir <リポジトリの絶対パス>
# {"base":"origin/develop","source":"nearest","candidates":[{"ref":"origin/develop","ahead":3}],"warnings":[]}
```

## 呼び出し側の共通ルール

1. `base` を `<BASE>` として `git diff <BASE>...HEAD` などに使う。エージェントや workflow には
   呼び出し側が決めた `<BASE>` を渡す（エージェント自身は `main` を仮定しない）
2. 報告の冒頭に「基準: `<base>`（`<source>`）」を1行出す。`warnings` があれば併せて提示する
3. **終了コードが 2（決められない）なら中断し、ユーザーに比較元を尋ねる。`main` へ黙って落ちない**
4. 1つの実行の中では最初に決めた `<BASE>` を使い回す（途中で決め直すと節ごとに差分がズレる）。
   `assess-change-size.sh` は同じヘルパーで決め、出力 JSON の `base_ref` / `base_source` に載せる

## 決め方（上から順）

| 順 | 条件 | `source` |
|---|---|---|
| 1 | `--base <ref>` が指定され、実在する（存在しなければ終了コード 2） | `explicit` |
| 2 | `gh` が使え、現在のブランチに PR があれば、その base（`origin/<base>`。候補に無い `release/*` も採る） | `pr` |
| 3 | 候補（`origin/HEAD` の指す先、`origin/develop`、`origin/main`、`origin/master`、`origin/trunk`）のうち、`HEAD` までのコミット数が最少のもの。同数なら左の順 | `nearest` |

- ローカルのブランチは候補にしない（`main` が古いことが多い）
- 決める前に `git fetch origin` を最大10秒で試す。失敗は警告にとどめて続行する（`--no-fetch` で止められる）
- `origin/HEAD` は未設定のリポジトリが多いので当てにしない（設定されていれば同数のときの先頭になるだけ）
