---
name: dev-design
description: 画面デザインフェーズ（オプション）。新規UIを伴う新機能で plan → setup の間に使用。claude.ai/design 上にデザインプロジェクトを作成し、URL/プロジェクトIDを Issue・引継書に記録する。実際の画面デザイン作業は claude.ai/design 上でユーザーが行う前提。`DesignSync` ツールが必須。
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob, Agent, DesignSync, gh, AskUserQuestion
---

# /dev-design - 画面デザインフェーズ（オプション）

## 位置づけ

- **フェーズ順**: `plan → design → setup → implement → ...`
- **対象案件**: 新規UIを伴う新機能のみ。バグ修正・小規模改善・サーバ側のみの変更ではスキップする
- **担当範囲**: claude.ai/design 上の「デザインプロジェクトの確保」と「URL/IDの記録」まで。実際の画面生成・ビジュアル決定は claude.ai/design 上の対話でユーザー（または別セッションのClaude）が進める

このスキルは**画面の最終ビジュアルを Claude Code で確定させるためのものではない**。「どこで画面デザインを作っているか」を `/dev` フローと Issue に紐付けるのが目的。

## リファレンス

- **引継書テンプレート**: [../_shared/reference/handover-template.md](../_shared/reference/handover-template.md)

## 前提

- 直前フェーズ（通常は `plan`）の引継書が `.agent/handover-*.md` に存在する
- Issue が作成済みで、本文に画面設計（変更対象画面一覧・ASCII ワイヤーフレーム等）が記載されている
- `DesignSync` ツールが利用可能（claude.ai/design 連携の認可済み）

## 手順

### D0. 直前フェーズの引継書を読み込む

```bash
LATEST=$(bash skills/_shared/scripts/latest-handover.sh)
```

引継書から以下を確認する:
- Issue 番号・URL
- 画面一覧（plan の A5 で Issue に記述された画面）
- 「画面デザインフェーズに進むか」のフラグ（plan 引継書のフェーズ固有セクション）

引継書に画面一覧が無い、もしくは「UIなし」と記載されていれば、**このフェーズはスキップ対象**である旨をユーザーに提示し、`/dev-setup` への進行を案内して終了する。

### D0.5. 複数方向プロトタイプ（任意・方向性が未確定の UI 案件のみ）

レイアウト・トーン・情報密度などの方向性が固まっていない場合のみ実施する。AskUserQuestion で「複数方向プロトタイプを作って比較するか」を確認し、確定済みなら D1 へ。

1. slug を決める（例: `issue-42-mypage`）
2. `dev-flow:ui-designer` エージェントを **Step 3-P（複数方向プロトタイプモード）** で起動し、意図的に異なる3〜4方向（既定3。起動時に方向数を明示）の自己完結静的 HTML を `.agent/mockups/<slug>/direction-N.html` に、比較表を `.agent/mockups/<slug>/README.md` に生成させる
3. 実行マニフェストに登録（マニフェスト記載ならスキャン仕様外ファイルも dev-hub で閲覧できる）:
   ```bash
   node skills/_shared/scripts/hub-run-add.mjs --repo <repoルート> \
     --run issue-<Issue番号> --label "<機能名>" --flow dev-design --issue <Issue番号> \
     .agent/mockups/<slug>/README.md \
     .agent/mockups/<slug>/direction-1.html .agent/mockups/<slug>/direction-2.html ...
   ```
4. `/dev-hub` を起動し、ユーザーに各 direction の閲覧と「採用/不採用＋理由」コメントを依頼する。コメントは 📮 ボタンで `.agent/feedback-inbox/<item-id>.json` に書き出してもらう
5. 選択結果の取り込み: 書き出された feedback-inbox の JSON を Read して採用方向と微調整点を確定し、読み終えた JSON は `processed/` へ移動する（この段階ではまだ実装コードが無いため `/auto-feedback --inbox` の Workflow は起動しない。実装後の成果物レビューでは従来どおり `/auto-feedback --inbox` を使う）
6. 採用方向・理由・微調整点を Issue コメント（D3 と同形式）と引継書に記録し、D1 以降では採用モックを claude.ai/design 作業と実装の参照とする

> **loop-review「複数の改善案を並べない」原則との混同注意**: あの原則はループ改善提案フェーズ（Debrief で最小変更1つに絞る）のもの。本ステップは**未確定な UX 方向の発散的探索**であり対象が別。実装・修正フェーズで複数実装案を並走させることは引き続き禁止。

### D1. claude.ai/design の既存プロジェクトを確認

`DesignSync` の `list_projects` で、書込み可能なデザインシステムプロジェクト一覧を取得する。

ユーザーに以下のいずれかを選ばせる（AskUserQuestion 推奨）:
- **既存プロジェクトを使う**: 一覧から `projectId` を選択
- **新規プロジェクトを作成する**: D2 へ進む
- **キャンセル**: フェーズ中断（引継書に「design スキップ」と記録）

既存プロジェクトを選んだ場合は `get_project` で `type: PROJECT_TYPE_DESIGN_SYSTEM` であること・`canEdit: true` であることを確認する。条件を満たさない場合は新規作成に誘導する。

### D2. 新規プロジェクト作成（既存利用しない場合のみ）

プロジェクト名は以下の規約で組み立て、ユーザー確認のうえ `DesignSync.create_project` を呼ぶ:

```
<リポジトリ名> - Issue #<Issue番号> - <短い件名>
```

例: `prj-OjtNihongo - Issue #42 - 受講者マイページ刷新`

`projectId` を取得する。プロジェクトURLは `https://claude.ai/design/<projectId>` の形式で組み立てる（実際のURLが返れば優先）。

### D3. Issue へコメント追記

`gh issue comment <番号> --body-file -` で、Issue に以下のフォーマットでコメントを追加する:

```markdown
## 画面デザインプロジェクト

- claude.ai/design URL: <URL>
- プロジェクトID: <projectId>
- 作成日時: <YYYY-MM-DD HH:MM>
- 対象画面（plan §画面設計より）:
  - <画面1>
  - <画面2>
  - ...

実際の画面ビジュアル作業は claude.ai/design 上で進めます。実装フェーズ（dev-implement）ではこの URL を再現の正解として参照してください。
```

### D4. 画面リストの確認とユーザーへの引継ぎ

- Issue の画面一覧をユーザーに提示
- 「claude.ai/design 上での作業」は本スキルでは行わない旨を明示
- ユーザーがブラウザで claude.ai/design を開き、対象画面のデザイン作業を進めることを案内
- 進行状況を本スキルが追跡する仕組みは持たない（次フェーズ以降は URL 参照のみ）

### D5. 引継書作成 ⚠ 必須（スキップ不可）

1. 引継書ファイルパスを発番:
   ```bash
   NEW=$(bash skills/_shared/scripts/new-handover-path.sh <Issue番号>)
   ```
2. 共通テンプレート + design フェーズ固有セクションを書き出す
3. ユーザーに「/clear して `/dev-setup` に進めますか？」と確認

#### design フェーズ固有セクション

```markdown
## 画面デザインプロジェクト
- claude.ai/design URL: <URL>
- プロジェクトID: <projectId>
- 利用形態: <新規作成 | 既存プロジェクト利用>
- 対象画面（plan §画面設計より）:
  - <画面1>
  - <画面2>

## 画面デザイン作業ステータス
- このスキルでは「プロジェクト確保とURL記録」までを実施
- 実画面の生成は claude.ai/design 上でユーザーが進行
- 実装フェーズ（dev-implement）開始時に「デザイン作業が必要な画面分が claude.ai/design 上で完了しているか」をユーザーに確認すること
```

## スキップ条件（早期終了）

以下のいずれかに該当する場合は D1 以降をスキップし、引継書に「design スキップ理由」を記録して `/dev-setup` への進行を案内する:

- 引継書または Issue に「UI 変更なし」「サーバ側のみ」と明記されている
- 既存画面の軽微な調整のみ（plan の A5 で「既存コンポーネント再利用のみ」とされている）
- ユーザーが「今回はスキップ」を選択

D0.5（複数方向プロトタイプ）は上記とは独立に、方向性が確定済みならスキップする。

## 出力物

- claude.ai/design プロジェクト（新規作成時）
- Issue へのコメント（プロジェクトURL・対象画面リスト）
- `.agent/handover-YYYYMMDD-HHMM-issue<番号>.md`（引継書）
- `.agent/mockups/<slug>/direction-N.html`＋hub-run マニフェスト登録（D0.5 実施時のみ）

## このスキルが直接やらないこと

- claude.ai/design 上の画面の生成・編集（`DesignSync.write_files` 等によるローカルHTML push は別スキル `/design-sync` の責務）
- デザインの良し悪し判定・テーマ選定（ユーザーが claude.ai/design 上で行う）
- 実装コードの生成（`/dev-implement` 以降の責務）

## dev-implement との連携

- `dev-implement` は実装開始時に最新の引継書から claude.ai/design URL を取得する
- ユーザーに「claude.ai/design 上でデザイン確定済みか」を確認してから実装に入る
- 未確定の画面がある場合は当該 Phase の implement を保留し、ユーザーにデザイン完了を促す
