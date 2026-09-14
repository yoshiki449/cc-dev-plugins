# STATE.md — ループ実行状態（run 横断）

<!--
dev-flow の各ループが終了時に自動追記する永続状態ファイル（durable spine）。
- Run Log: 1 run = 1 行。ループ側が append する
- Open Items: 未解決の申し送り。人間 or 次の run が解決したら「行ごと削除」する（prune 規約）
-->

## Run Log

| date | loop | mode | iterations | commits | tokens_est | final_status | notes |
|---|---|---|---|---|---|---|---|

<!-- notes 列の記録規約:
  - halted-supervisor / halted-checkpoint の run は、人間の妥当性判定を `halt=妥当` または `halt=過剰` で必ず記録（誤 halt 率の集計に使う）
  - report モードの run は主要 findings 件数を記録
-->

## Open Items

<!-- 形式: `- [YYYY-MM-DD] <loop名>: <内容>（→ 推奨アクション）` 解決したら行ごと削除 -->

（なし）

## 運用メモ

- Run Log が 50 行を超えたら古い行を `.agent/state-archive/STATE-<YYYYMM>.md` に移してよい
- 引退させたループ: （なし。引退時は `- <loop名>: status: retired（YYYY-MM-DD、理由）` を記録）
