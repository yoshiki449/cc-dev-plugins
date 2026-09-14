---
name: dev
description: 開発フロー統合ルーター。新機能開発・継続改修・保守タスクのフェーズ管理を行い、`/dev-plan` `/dev-design` `/dev-setup` `/dev-implement` `/dev-verify` `/dev-fix` `/dev-test-spec` `/dev-qa` `/dev-ship` のうち次に必要なフェーズへ案内する。ユーザーが「今どういう状態？」「未リリース／本番適用できていない改修は何があったっけ？」「○○機能の現状を教えて」「○○の続きをしたい」「○○の改修に着手したい」「PRを分けたい」「リリース準備したい」のような **開発状態の問い合わせ・継続意思・フロー意思決定** を口にしたら必ず起動する。新機能だけでなく、バグ修正・保守タスク・改修途中の再開・PR運用相談もこのルーターから入る。
user-invocable: true
---

# /dev - 開発フロー管理（ルーター）

各フェーズは**独立スキル**として分離されている。このスキルは状況を判断し次のフェーズを案内するルーターとして機能する。

## フェーズ一覧

| フェーズ | スキル | 内容 |
|---------|---------|------|
| 企画 | `/dev-plan` | 要件調査 → 仕様設計 → 画面設計(DESIGN.md) → Issue作成 |
| 画面デザイン（任意） | `/dev-design` | claude.ai/design 上にデザインプロジェクトを作成し、URL を Issue・引継書に記録（新規UIを伴う案件のみ） |
| 準備 | `/dev-setup` | ブランチ作成 → Docker起動 → DB初期化 |
| 実装 | `/dev-implement` | TDDサイクル（テスト先行→実装→レビュー） |
| 検証 | `/dev-verify` | 動作確認 → E2Eテスト作成・実行 → バグ修正 |
| 修正 | `/dev-fix` | 修正希望 → Issue仕様比較 → 修正方針 → 実装 → 検証 |
| テスト仕様書 | `/dev-test-spec` | テスト計画作成（自動/手動分類）→ Docs版（自動テストサマリー）＋スプレッドシート版（手動テスト・社内規定フォーマット）作成 → レビュー |
| QA | `/dev-qa` | 前提・ゴール収集 → 自律探索（Playwright MCP）→ 観点別評価 → QAレポート |
| テスト台帳 | `/dev-test-ledger` | 自動＋手動の統合カバレッジ確認（qa 後・ship 前）。手動仕様書があれば🟣手動漏れ＝真の穴を検出。ship の E1.5c でも自動実行される |
| 完了 | `/dev-ship` | PR作成 → history更新 → 日報 |

## 経路パターン（規模・種別による動的選択）

案件の性質に応じて経路を動的に組む。代表的なパターン:

- **新機能開発（UIあり・フル）**: `plan → design → setup → implement → verify`（Phase単位ループ）→ `test-spec` → `qa` → `test-ledger`(統合) → `ship`
- **新機能開発（UIなし・フル）**: `plan → setup → implement → verify`（Phase単位ループ）→ `test-spec` → `qa` → `test-ledger`(統合) → `ship`（design スキップ）
- **バグ修正のみ**: `fix → verify → ship`（plan/design/setup/implementを飛ばす）
- **小規模改善**: `implement → verify → ship`（plan/design/setup/qaを飛ばす）
- **既存機能のUI調整**: `fix → verify → qa → ship`（design は通常不要。大幅な作り直しなら `design` を挟む）

ユーザーから依頼内容を聞き、上記から適切な経路を提案する。迷う場合はユーザーに確認する。

> ⚠ **`qa` を飛ばせるかどうかは、ここでは確定しない。**
> リスク HIGH かつ frontend + backend の両スコープに跨る変更では qa のスキップが**禁止**される
> （判定器の `gates.qa == "required"`）。**この判定にはコード差分が必要**で、経路を選ぶ時点では
> まだ差分が無い（`lines:0` ＝ 最軽量判定になる）ため、ルーターでは判定を採用しない。
> **最終判定は `dev-ship` の E0.7 が持つ。** ここで qa を飛ばす経路を選んでも、ship で
> `required` と判定されれば dev-qa の実施を確認され、未実施なら中断する。

## Phase単位での implement → verify 繰り返し

複数Phaseに分割された開発では、**全Phaseを実装してからまとめてverifyするのではなく、Phase単位でimplement→verifyを繰り返す**。

```
Phase N:  /dev-implement → /dev-verify → （fixがあれば /dev-fix）
Phase N+1: /dev-implement → /dev-verify → （fixがあれば /dev-fix）
...
全Phase完了: /dev-qa →（指摘修正は /dev-fix → 再QA）→ /dev-ship
```

**理由**: バグの早期発見・修正コストの低減、実装直後なら文脈が残っていて効率的。

## 現在フェーズの判定

以下の順で確認し、該当するフェーズを案内:

1. GitHub Issueが未作成 → `/dev-plan` を案内
2. 新規UIを伴う案件で claude.ai/design プロジェクト未作成 → `/dev-design` を案内（UIなし案件はスキップ）
3. 開発環境が未構築 → `/dev-setup` を案内
4. 直前Phaseの実装が完了し未検証 → `/dev-verify` を案内
5. 実装タスク（未着手Phase）が残っている → `/dev-implement` を案内
6. ユーザーから修正希望がある → `/dev-fix` を案内
7. テスト仕様書が未作成 → `/dev-test-spec` を案内（小規模修正の場合はスキップ可）
8. 全Phaseの実装・検証が完了し `.agent/reports/qa-report-*.md`（旧形式 `.agent/qa-report-*.md` も可）が未作成 → `/dev-qa` を案内
9. QA完了・`.agent/test-ledger/<Issue番号>.md` が未生成 or 古い（test-spec や実装の更新後） → `/dev-test-ledger`（統合モード）を案内
10. PRが未作成 → `/dev-ship` を案内
11. すべて完了 → 完了報告

**注**:
- `/dev-design` は新規UIを伴う新機能のみ対象。バグ修正・小規模改善・サーバ側のみの変更ではスキップ。判定材料は plan の引継書または Issue 本文の画面一覧。
- `/dev-fix` は `/dev-verify` 後に修正希望が出た場合に使用。繰り返し実行可能。
- `/dev-test-spec` はテスト仕様書が必要な案件で使用。小規模修正ではスキップ可。成果物は Docs 版（自動テストサマリー）とスプレッドシート版（手動テスト仕様書）の2本立て。
- `/dev-qa` は全Phaseの実装・検証完了後、ship前に1回実施。fix後の再QAは指摘箇所周辺に絞ってよい。**小規模経路でスキップした場合も、ship の E0.7 で `gates.qa == "required"` と判定されたら実施が必要になる**（差分レビューでは「本来あるべきなのに追加コミットが無いファイル」を検知できないため）。
- 判定ルール4: 実装済み・未検証のPhaseがあればverifyを優先案内する。

## 引継書（HANDOVER）

各フェーズ終了時に `.agent/` に引継書を新規作成する（既存ファイルの上書き禁止）。

- **保存先**: `.agent/handover-YYYYMMDD-HHMM[-issue{番号}].md`（例: `handover-20260330-1430-issue63.md`、Issue番号は任意）
- **毎回新規ファイル**を作成（上書きしない）。過去の引継書はストックとして残る
- **フェーズ開始時**: `ls -1 .agent/handover-*.md | tail -1` で最新の引継書を読み込む
- **フェーズ終了時**: 新しい引継書を作成し、ユーザーに「/clearして次フェーズに進めますか？」と確認
- **/bye 実行時にも引継書を作成する**（フェーズ名は `bye`）

### 引継書に含める内容
1. 現在の状態（Issue URL, ブランチ名, 完了フェーズ, 次のフェーズ）
2. 完了した作業
3. 変更ファイル一覧（`git diff --name-only` の結果）
4. 未完了のタスク
5. ユーザーからの指示・フィードバック
6. 却下した案と理由
7. 次フェーズへの引継事項（参照ファイル、注意点）
8. 環境情報（ポート、コンテナ名）

## 使い方

ユーザーが `/dev` と入力したら:
1. プロジェクトの状態を確認（Issue有無・ブランチ・実装状況・引継書・qa-report の有無）
2. ユーザーに依頼内容（新機能/バグ修正/小規模改善 等）を確認
3. 「経路パターン」と「現在フェーズの判定」を踏まえ、次にやるべきフェーズ（`/dev-xxx`）を案内する

このスキル自体はフェーズ実行を行わない。各フェーズスキル（`/dev-plan` 等）はユーザーが明示的に起動するか、別途独立スキルとして自律起動する。

## 自動連鎖実行したい場合

経路全体を1コマンドで連鎖実行したい場合は `/dev-orchestrator` を起動する。プリセット（`full` / `bugfix` / `small`）または任意のカスタム経路を選び、フェーズ境界でユーザー確認を挟みながら順次実行される。中断・再開にも対応。

```
/dev-orchestrator full        # plan → ... → ship をフル実行
/dev-orchestrator bugfix      # fix → verify → ship のみ
/dev-orchestrator implement,verify,qa,ship  # カスタム経路
```

## 中間層: 半自律ループ（`/dev-loop`）

中規模改修で「`auto-build` は重すぎるが、`dev-implement` → `dev-self-review` → `dev-verify` を毎回手で打つのは面倒」というときは `/dev-loop` を使う。

- 1コマンドで `implement → self-review → verify` を自動ループ
- self-review／verify で指摘が出たら自動で `implement` または `dev-fix` に戻る（findings の category で分岐）
- 境界確認は **verify OK 後の1回のみ**（「完了 / 修正点を追加 / 中断」の3択）
- 暴走防止（2層）:
  - 機械的ガード: `max_iterations`（3）/ `max_commits`（10）/ `max_commits_per_iter`（5）/ `max_loop_runtime_minutes`（60）/ ハッシュ thrashing 検知 / `loop_baseline_sha` ロールバック
  - 監視エージェント: `loop-supervisor`（1/iter で scope-drift / regression / 意味的 thrashing 判定）+ `stop-judge`（verify OK 時に Issue ゴール達成度判定）
- `supervisor=off` で監視エージェント無効化（軽量モード）
- Workflow ツール不使用なので、進行中もメインセッションで対話可能

詳細は `/dev-loop` の SKILL.md 参照。`/dev-orchestrator` との使い分け:

| 用途 | スキル |
|---|---|
| フル経路を一方通行で流す | `/dev-orchestrator full` |
| 中規模改修を自動ループ | `/dev-loop` |
| DESIGN.md 確定済で完全自律 | `/auto-build` |
