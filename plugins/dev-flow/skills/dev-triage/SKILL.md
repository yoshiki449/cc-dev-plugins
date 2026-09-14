---
name: dev-triage
description: Daily Triage 常駐ループ（Loop Engineering の L1 パターン、**報告のみ・コード変更ゼロ**）。対象プロジェクトのオープン Issue・未 push commit・STATE.md の滞留項目・ループ運用メトリクス（halted 率／supervisor 誤 halt 率）をスキャンし、優先度付きレポート `.agent/reports/triage-<日付>.md` を出力する。何も対応すべき項目が無ければ Run Log 1行だけ書いて即終了（early exit、低コスト）。定期実行（毎朝の crontab 等）に登録して「勝手に回り続けて問題を拾ってくる」常駐ループとして使うのが本来の用途。ユーザーが「トリアージして」「今日の状況をスキャンして」「プロジェクトの健康状態を確認して」「daily triage」「ループのメトリクスを見せて」「誤 halt 率を確認して」と言ったら起動する。コード変更・コミット・Issue 操作は一切行わない（提案のみ）。
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob, gh
---

# /dev-triage - Daily Triage 常駐ループ（L1 固定）

## 位置づけ

loop-engineering の **Daily Triage パターン**の実装。autonomy level は **L1（report-only）固定**で、L2/L3 への昇格はない — 発見と報告だけを行い、対応は人間または他のスキル（`/dev-fix`, `/dev-loop` 等）に委ねる。

| 原則 | 実装 |
|---|---|
| Triage パスは低コスト | 対応項目ゼロなら early exit（Run Log 1行のみ） |
| 報告のみ | ソース変更・commit・push・Issue 作成/クローズを一切しない |
| durable spine | 毎回 `.agent/STATE.md` を読み、Run Log に追記する |
| メトリクス監視 | loop-metrics.sh の集計を毎回同梱し、減速・停止基準と突き合わせる |

## 手順

### T0. ループ運用ファイルの確保

1. `bash skills/_shared/scripts/ensure-loop-files.sh` を実行
   - 新規生成されたファイルがあれば「初回セットアップとして LOOP.md / STATE.md / loop-denylist.txt を生成しました。LOOP.md の目的・予算・denylist をプロジェクトに合わせて編集してください」と報告する
2. `.agent/LOOP.md` を Read し、以下を把握:
   - 監視スコープ（対象ブランチ・ディレクトリ）
   - `scan_tests` / `scan_dependencies`（**false なら該当スキャンをスキップ**。コスト制御のための opt-in）
   - 減速・停止・引退基準

### T1. スキャン（読み取りのみ、可能なものは並列）

1. **Issue 鮮度**: `gh issue list --state open --json number,title,updatedAt,labels --limit 50`
   - 14日以上更新のないオープン Issue を「滞留」としてマーク
2. **git 状態**: `git status --porcelain`（未コミット変更）、`git log origin/<対象ブランチ>..HEAD --oneline`（未 push commit）、`git branch --show-current`
3. **STATE.md 滞留**: `.agent/STATE.md` の Open Items を Read し、日付が7日以上前の項目を「滞留」としてマーク。同一項目が2 run 連続で残っている場合は LOOP.md のエスカレーションルールに従い警告
4. **テスト健全性**（`scan_tests: true` のときのみ）: プロジェクトのテストコマンド（`npm test` 等）を実行し、fail / skip 数を記録
5. **依存の老朽化**（`scan_dependencies: true` のときのみ）: `npm outdated` 等で major 遅れの依存を列挙

### T2. early exit 判定

T1 の結果、以下すべてに該当すれば**対応項目ゼロ**とみなす:

- 滞留 Issue なし／未 push commit なし／未コミット変更なし
- STATE.md Open Items に滞留なし
- （opt-in スキャンを実行した場合）テスト全 PASS・major 遅れ依存なし

対応項目ゼロなら: STATE.md の Run Log に1行 append（`| <日時> | dev-triage | report | 1 | 0 | <概算token> | report-done | 対応項目なし |`）して**即終了**。レポートファイルは作らない。

### T3. メトリクス集計

`bash skills/_shared/scripts/loop-metrics.sh` を実行し、出力を取得する。

- **誤 halt 率 30% 超の警告**が出ていたら、レポートの優先項目に「loop-supervisor のプロンプト見直し」を P2 で追加
- LOOP.md の減速・停止基準（token 支出・コスト>価値）に照らして該当があれば同様に追加
- STATE.md の Run Log で最後の `loop-review` 行が **14日以上前**（または一度も無い）なら、P2 に「`/loop-review` の実施（ループ効果の週次評価）」を追加

### T4. レポート出力

`.agent/reports/triage-<YYYYMMDD>.md` に以下の構成で出力する:

```markdown
# Daily Triage — YYYY-MM-DD

## 優先対応（P1: 今日対応すべき）
- <項目>（→ 推奨アクション例: `/dev-fix "..."` ／ 手動で git push）

## 要注意（P2: 今週中に判断）
- <滞留 Issue #N: タイトル（XX日更新なし）>（→ クローズ or 再計画）

## 情報（P3: 認知のみ）
- <major 遅れ依存 等>

## ループ運用メトリクス
<loop-metrics.sh の出力をそのまま貼る>

## 次アクションまとめ
- <P1/P2 の推奨コマンド一覧>
```

推奨アクションは**提案のみ**。このスキルから `/dev-fix` 等を自動起動してはならない。

### T5. STATE.md 更新

1. Run Log に1行 append: `| <日時> | dev-triage | report | 1 | 0 | <概算token> | report-done | P1:<n>件 P2:<n>件 P3:<n>件 |`
2. **P1 項目**を Open Items に追記（既に同内容の項目があれば重複追加しない）
3. Open Items のうち今回のスキャンで解決を確認できた項目（例: 未 push だった commit が push 済み）は **prune（行削除）** し、レポートに「解決済みとして削除: ...」と記載

### T6. 報告

ユーザーへの最終報告には必ず含める:
- P1 / P2 / P3 の件数と要点
- レポートファイルのパス
- メトリクス警告（あれば）
- early exit だった場合はその旨1行

## 禁止事項（L1 固定）

- ソースコードの Write / Edit（書いてよいのは `.agent/` 配下のレポート・STATE.md のみ）
- `git commit` / `git push` / ブランチ操作
- `gh issue create` / `gh issue close` / `gh pr` 系の書き込み操作（読み取りのみ可）
- 発見した問題の「ついで修正」（必ず提案に留める）

## 定期実行への登録

### 主案: OS crontab（恒久・推奨）

WSL では cron サービスの起動が前提（`sudo service cron start`。自動起動は `/etc/wsl.conf` の `[boot] command` に記載）。

```bash
crontab -e
# 毎朝 7:07 に対象プロジェクトで triage を実行（:00 ちょうどを避ける）
7 7 * * * cd /path/to/project && claude -p "/dev-triage" --permission-mode acceptEdits >> ~/.cc-plugins/logs/dev-triage.log 2>&1
```

- `claude -p` は headless 実行。`--permission-mode acceptEdits` で `.agent/` への書き込みを許可する
- ログ先ディレクトリは事前に `mkdir -p ~/.cc-plugins/logs`
- 複数プロジェクトに入れる場合は行を分け、分をずらす（7:07 / 7:17 / ...）

### 副案: CronCreate（セッション内試用）

対話セッション中に「毎朝7時すぎに /dev-triage を回して」と依頼すれば CronCreate で登録できるが、**セッション限定**（セッション終了で消滅、最長7日で自動失効）。挙動確認の試用に向く。恒久運用は crontab へ。

## 関連

- `.agent/LOOP.md` — このループの予算・opt-in スキャン・エスカレーション基準の宣言元
- `.agent/STATE.md` — Run Log / Open Items の永続先
- `skills/_shared/scripts/loop-metrics.sh` — メトリクス集計の実体
- `/dev-loop mode=report` — 実装対象が決まっているときの L1（こちらは Issue ゴール前提）
