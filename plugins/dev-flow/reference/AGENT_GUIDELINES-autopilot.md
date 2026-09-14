# Agent Guidelines — Autopilot（claude-autopilot-kit）

claude-autopilot-kit のエージェント連携ガイドライン。**人間タッチポイント3点（要件・設計・成果物）以外は AI 自律ループ**という設計思想に従う。

> このファイルは `~/.claude/agents/AGENT_GUIDELINES-autopilot.md` として配置される。claude-harness-kit の `AGENT_GUIDELINES.md` と名前空間で共存できるようリネーム済み。

## 1. 役割マップ

```
TP1: 要件定義レビュー（人間）
       ↓
   spec-writer（REQUIREMENTS.md ドラフト）
       ↓ 人間確定
TP2: 設計レビュー（人間）
       ↓
   designer（DESIGN.md ドラフト）
       ↓ 人間確定
   build.workflow.js 起動（自律完走）
       ├── test-writer（RED）
       ├── implementer（GREEN/REFACTOR）
       ├── adversarial-verifier（敵対的検証 / 多レンズ並列）
       ├── e2e-test-generator（E2E spec 生成）
       ├── qa-explorer（Playwright 自律探索 / ブラウザ独占）
       ├── qa-goal-evaluator / qa-technical-evaluator / qa-ux-evaluator（3観点並列評価）
       ├── security-tester（OWASP 観点）
       └── Code-Reviewer（最終品質チェック）
       ↓ Workflow 完走（最大 5 巡）
TP3: 成果物レビュー（人間） — 動画＋PR で確認
       ↓ フィードバック
   feedback-interpreter（自然言語 → FeedbackItems）
       ↓
   feedback-fix.workflow.js 起動（修正ループ自律完走）
       └── 上記サブセット（implementer + テスト・QA 再試走）
```

## 2. すべてのレビュー系エージェントの共通規約

- 出力に `confidence: 0-100` を含める
- 重要度（Critical / Major / Minor）を明示
- 対象ファイル＋行を `target` で明示
- 推奨対応を `recommendation` で1〜2文

## 3. ブラウザ・MCP 排他制御

- **Playwright MCP のブラウザは 1 セッション**: build / feedback ワークフローでは qa-explorer を**単独実行**する Phase を作り、その間に他エージェントのブラウザ操作は行わない
- 動画録画は `--caps=devtools` 付き起動時のみ有効。未対応環境では qa-explorer は録画なしで継続し、その旨を `recording_available: false` で報告

## 4. 並列実行ルール

- claude-harness-kit の「並列上限3」は本ハーネスでは**緩和**（Workflow ツールの 16 並列を活用）
- 同種エージェントを観点別に並列起動するパターンを推奨（QA 評価3並列、adversarial-verifier 多レンズ並列など）

## 5. コード書き換え権限

| 役割 | コード書き換え | 備考 |
|---|---|---|
| spec-writer / designer / feedback-interpreter | ❌ | REQUIREMENTS.md / DESIGN.md / FeedbackItems のみ書き出し |
| test-writer | ✅ テストファイルのみ | 実装ファイルは触らない |
| implementer | ✅ 実装ファイルのみ | テストファイルは触らない |
| adversarial-verifier / Code-Reviewer / 各 evaluator / security-tester | ❌ | 指摘までが責務 |
| qa-explorer | ✅ 証跡ファイルのみ | 本体コードは触らない |
| e2e-test-generator | ✅ E2E spec ファイルと playwright.config.ts のみ | アプリ本体は触らない |

## 6. 引継ぎファイル

人間タッチポイント間の引継ぎは以下のファイルを唯一の真実とする:

- `REQUIREMENTS.md` — TP1 で確定
- `DESIGN.md` — TP2 で確定
- `.agent/autopilot/<task_id>/review/review-video-index.md` — TP3 で確認
- `.agent/autopilot/<task_id>/log.md` — Workflow 実行ログ（参考）

引継書（claude-harness-kit の `handover-*.md`）は本ハーネスでは使用しない（自律完走のため）。

## 7. ループ停止条件（Workflow 共通）

優先順:
1. **Critical/Major 0 件**かつ全テスト PASS（`all-green`）
2. 試行回数 上限到達（`halted-attempts`）
3. budget remaining < 50,000 トークン（`halted-budget`）
4. 致命的エラー（`halted-error`）

いずれの場合も `review-index.json` の `final_status` で人間に報告する。

## 8. 動画録画（必須要件）

- E2E: `playwright.config.ts` に `video: 'on'`
- QA: `qa-explorer` が `browser_start_video` / `browser_stop_video` で 1 ゴール 1 動画
- すべての動画は最終的に `.agent/autopilot/<task_id>/review/videos/` に集約
- 合計 50MB 以下なら ZIP 化して GitHub Release Assets として PR からリンク

詳細は `skills/auto-build/SKILL.md` 参照。
