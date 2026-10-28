# dev-loop: 位置づけ・役割分担・コスト（SKILL.md から分離した説明）

## このスキルが埋める空白

| スキル | 形態 | コマンド入力回数 | 並列／ガード | 用途 |
|---|---|---|---|---|
| `/dev-implement` ほか個別 | 単発 | 各フェーズ毎に1回 | 各スキルの並列上限 | フェーズ単体で十分なとき |
| **`/dev-loop`（本スキル）** | **逐次ループ** | **1回**で implement↔review↔verify を往復 | 軽量ガード（max_iter / max_commits / thrashing 検知） | **中規模改修・既存機能の小〜中サイズ修正** |
| `/dev-orchestrator` | パイプライン | 1回（毎フェーズ確認） | フェーズ間ユーザー確認 | フル経路を一直線に流したいとき |
| `/auto-build` | Workflow 自律 | 1回（完走後サマリのみ） | loop-supervisor / stop-judge / 16並列 | フル機能・DESIGN.md 確定済・完全自動完走を許容 |

## 関連スキルとの違い

- **`/dev-orchestrator small`**: パイプライン（implement→verify→ship を 1 巡）。ループしない。フェーズ間で毎回確認。
- **`/auto-build`**: Workflow ツールで完全自律。Playwright MCP 専有・loop-supervisor / stop-judge ゲート付き・DESIGN.md 確定が前提。
- **`/dev-loop`（本スキル）**: メインセッション逐次実行で `implement↔review↔verify` をループ。verify OK 後だけユーザー確認。ship・QA は別途。

### 機械的ガード vs 監視エージェントの役割分担

| シグナル | 機械的ガード | 監視エージェント |
|---|---|---|
| iteration 回数の暴走 | ✅ `max_iterations` | — |
| commit 量産 | ✅ `max_commits`, `max_commits_per_iter` | — |
| 長時間放置 | ✅ `max_loop_runtime_minutes` | — |
| 文字列一致レベルの同一 findings | ✅ ハッシュ thrashing | — |
| 意味的に同じだが文字列が違う findings | ❌ 検知不能 | ✅ `loop-supervisor` halt-thrashing |
| scope 外への drift（仕様外実装） | ❌ 検知不能（scope-drift 警告は単純な行数指標のみ） | ✅ `loop-supervisor` halt-scope-drift |
| 他テストの破壊（regression） | △ verify 側の失敗で間接検知 | ✅ `loop-supervisor` halt-regression |
| verify 緑だが Issue ゴール未達 | ❌ 検知不能 | ✅ `stop-judge` done=false |

両者は **重ねて** 使う前提（auto-build と同じ思想）。機械的ガードはコスト 0 で必ず効く下限、監視エージェントは意味理解の上限。

### コスト

- `loop-supervisor`: 1 iteration あたり 5〜15k tokens
- `stop-judge`: 1 loop あたり 3〜8k tokens
- 想定オーバーヘッド: 3 iter のループで **約 25〜55k tokens**（`auto-build` の FixLoop と比べて1桁少ない）

cost が気になるとき／オフライン環境では `/dev-loop supervisor=off` で機械的ガードのみのモードへ。

### 監視可能性

- ループ実行中は **進捗ファイル `.agent/devloop-<TS>.md`** をユーザーが別端末で `tail -f` できる
- 各 iteration の `category 判定 / findings ハッシュ / commits delta / 経過時間` を記録するので、後から「なぜ止まらなかったか」を後追い可能
