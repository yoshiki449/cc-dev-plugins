---
name: auto-design
description: 確定済み REQUIREMENTS.md から DESIGN.md（技術設計＋画面設計＋テスト方針＋Phase 分割）を生成し、人間レビュー（TP2）を受けて確定するフェーズ。autopilot ハーネスの2番目の人間タッチポイント。コードは生成しない。
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob, Agent, WebSearch, gh, AskUserQuestion, mcp__context7__*
---

# /auto-design - 技術設計フェーズ（人間タッチポイント2）

## 概要

autopilot ハーネスの **3つの人間タッチポイントのうちの2番目**。確定済み REQUIREMENTS.md から DESIGN.md ドラフトを生成し、人間レビューで Open Questions を解消して確定する。

このスキルは軽量で **Workflow ツールを起動しない**。複数調査が必要な場合は `designer` エージェントが内部で逐次に進める。

## 入力

- 確定済みの `docs/REQUIREMENTS.md`（無ければルート直下 `./REQUIREMENTS.md` をフォールバックで探す）
- 既存リポジトリ構造

## 手順

> **フェーズ開始時の共通前処理**: `mkdir -p .agent && git branch --show-current > .agent/.dev-flow-active` を実行してフェーズマーカーを書き込む（suggest-dev-phase hook のフェーズ想起案内を沈黙させる。`/dev-ship` E7 が掃除する）

### D0. 前提確認

1. `REQUIREMENTS.md` が存在し（docs/ 優先 → ルート直下フォールバック）、Open Questions セクションが残っていないことを確認
2. 残っていれば「先に /auto-spec で確定してください」と中断
3. 既存の `DESIGN.md` があれば更新方針を AskUserQuestion で確認

### D0.5. 複数方向プロトタイプ（任意・方向性が未確定の UI 案件のみ）

新規 UI を伴い、レイアウト・トーン・情報密度などの方向性が固まっていない場合のみ実施する。AskUserQuestion で「複数方向プロトタイプを作って比較するか」を確認し、確定済み・UI なしなら D1 へ。

1. slug を決める（Issue があれば `issue-<番号>-<slug>`、なければ `req-<slug>`）
2. `dev-flow:ui-designer` エージェントを **Step 3-P（複数方向プロトタイプモード）** で起動し、REQUIREMENTS.md の主要ユーザーストーリーを題材に、意図的に異なる3〜4方向（既定3。起動時に方向数を明示）の自己完結静的 HTML を `.agent/mockups/<slug>/direction-N.html` に、比較表を同ディレクトリの `README.md` に生成させる
3. 実行マニフェストに登録し、`/dev-hub` でユーザーに閲覧・「採用/不採用＋理由」コメント（📮 書き出し）を依頼する:
   ```bash
   node skills/_shared/scripts/hub-run-add.mjs --repo <repoルート> \
     --run <slug> --label "<機能名>" --flow auto-design \
     .agent/mockups/<slug>/README.md .agent/mockups/<slug>/direction-*.html
   ```
4. 書き出された `.agent/feedback-inbox/<item-id>.json` を Read して採用方向と微調整点を確定し、読了後 `processed/` へ移動する（この段階では実装コードが無いため `/auto-feedback --inbox` は起動しない）
5. 採用方向・理由・微調整点を REQUIREMENTS.md 末尾ではなく **D1 の designer への入力**として渡す（下記）。運用ルールは dev-design D0.5 と同一（loop-review「複数案を並べない」原則とは対象が別）

### D1. designer エージェント起動

`dev-flow:designer` エージェントを起動。以下を渡す:
- `REQUIREMENTS.md` のパス
- 既存リポジトリ構造
- 出力先: `docs/DESIGN.md`（ドキュメント保管規約。ルート直下には置かない）
- D0.5 実施時: 採用モックのパス（`.agent/mockups/<slug>/direction-N.html`）と採用理由・微調整点（§4 画面設計のレイアウト・トーンの参照とさせる）

designer は以下を実施:
1. REQUIREMENTS.md の US と検証条件を熟読
2. 既存リポジトリ構造を把握
3. ライブラリ最新版を WebSearch / context7 で確認
4. DESIGN.md テンプレート（agents/designer.md 参照）に沿って書き出し
5. Phase 分割（10-15 ファイル/Phase 目安）を含める

### D2. 人間レビュー（TP2）

1. まず DESIGN.md の **§0「レビューしてほしい判断」** を提示し、AskUserQuestion で1件ずつ「この判断のままで良いか／変更するか」を確認する（変更可能性の高い順）。変更が出たら該当 § に反映してから次へ
2. 続いて生成された `DESIGN.md` の章ごとにユーザーに提示
3. **重点的に確認させる箇所**:
   - データモデル（後で変更困難）
   - API 仕様（クライアントとの契約）
   - Phase 分割（実装順序の妥当性）
   - テスト方針（QA ブリーフ・E2E 範囲）
   - 技術選定の根拠（依存ライブラリのバージョン）
4. **Open Questions** があれば AskUserQuestion で1問ずつ回答を求める
5. 回答を DESIGN.md に反映

### D3. 確定

1. ユーザーに最終確認: 「この内容で確定し、自律実装フェーズ（/auto-build）に進めますか？」
2. 確定後、`docs/DESIGN.md` を Git に追加してコミット: `docs: 技術設計書を確定`
3. 次のアクション提示: 「/clear して `/auto-build` に進めますか？」

## 出力

- `docs/DESIGN.md`（確定版・Open Questions セクションなし）
- コミット 1 つ

## 確定の判断基準

- データモデル・API・画面が一通り定義されていること
- Phase 分割の各 Phase が 10-15 ファイル目安、依存関係が明示されていること
- E2E テスト方針に `video: 'on'` 必須（レビュー用録画）が明記されていること
- QA ブリーフ（起動URL・認証情報・観察可能なゴール）が含まれていること
- セキュリティ観点（OWASP のうち関係するもの）が触れられていること
- Open Questions が 0 件
- §0「レビューしてほしい判断」の各判断がユーザー確認済みであること

## Workflow ツールについて

このスキルは Workflow ツールを起動しない（人間レビュー前提のため）。

## Stop（このスキルが超えてはいけない境界）

Loop Engineering の Stop 原則を、ループしないこのスキルにも適用する:

- **Never auto-approve**: `DESIGN.md` 生成後、人間レビュー（TP2）を必ず経由する。スキル自身が「確定」状態にしない
- **Never invoke /auto-build without TP2 sign-off**: 人間が DESIGN.md を承認するまで次フェーズへ進めない
- **Anything uncertain → 質問**: 設計判断が割れるポイント（DB スキーマ・認可境界・外部 API 仕様）は推測で書かず AskUserQuestion で確認

## 次フェーズ

- 確定後 → `/auto-build`（Workflow による自律完走）
