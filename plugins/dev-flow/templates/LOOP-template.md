# LOOP.md — ループ運用宣言書

<!--
このファイルは dev-flow の各ループ（dev-triage / dev-loop / auto-build / auto-feedback）が
起動時に読み込む「このプロジェクトでループをどう動かすか」の宣言書。人間が育てる。
「キー: 値」形式の行はスキルが機械的に読むので、キー名は変えないこと。
-->

## 目的

（このプロジェクトで自律ループに何を任せるか。1〜3行で）

## 非ゴール

（ループにやらせないこと。例: 本番デプロイ、DB スキーマ変更、リリースノート以外のドキュメント大改編）

## 監視スコープ

- 対象ブランチ: main
- 対象ディレクトリ: （例: `src/`, `tests/`。空欄なら全体）

## Autonomy Level（loop 種別ごと）

| loop | level | 備考 |
|---|---|---|
| dev-triage | L1 | 報告のみ（このループは L1 固定） |
| dev-loop | L2 | 自動修正＋人間ゲート（verify OK 後に確認） |
| auto-build | L1 | まず `report_only: true` で試走。安定を確認してから L3 へ |
| auto-feedback | L1 | 同上 |

L1 = report-only（変更ゼロ）／ L2 = 自動修正＋人間ゲート／ L3 = 無人完走。
**新しいプロジェクト・新しいループは必ず L1 から始める**（Never skip L1）。

## 予算（Budget）

<!-- 各ループが引数未指定時の既定値として読む。引数指定は常にこちらより優先 -->

- max_tokens_per_day_estimate: 2000000
- max_iterations: 3
- max_commits: 10
- max_attempts: 5
- budget_exceeded_action: ループを停止し人間に通知（自動で翌日に持ち越さない）

## dev-triage スキャン設定

<!-- true にすると triage のコストが増える。まず false で運用し、必要になったら開ける -->

- scan_tests: false
- scan_dependencies: false

## Denylist

自動編集禁止パスは **`.agent/loop-denylist.txt` で管理**（単一ソース）。このファイルには書かない。

## エスカレーションルール

- loop-supervisor が `escalate-human` を返した → 即停止して人間確認
- 同一項目が 2 run 連続で STATE.md の Open Items に残った → dev-triage が警告
- 10 ファイル以上の変更を伴う修正 → 人間承認必須
- denylist 抵触が必要な修正 → 実行せず申し送り（人間が denylist を見直すか手動対応）

## 減速・停止・引退基準

<!-- loop-engineering operating-loops.md 準拠。dev-triage がメトリクスと突き合わせてチェックする -->

- 誤 halt 率（supervisor の過剰 halt 判定）が 30% 超 → loop-supervisor のプロンプト見直し
- 週の token 支出見積りが予算の 80% 超 → 実行頻度を落とす
- 2週連続で「コスト > 得られた価値」→ そのループを引退（STATE.md に `status: retired` を記録）
- 本番障害対応中・破壊的スキーマ変更中 → すべてのループを一時停止
