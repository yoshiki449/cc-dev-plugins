---
name: dev-test-spec
description: テスト仕様書フェーズ。テスト仕様書が必要な案件で使用（小規模修正ではスキップ可）。自動テスト・手動テストの分類 → Googleドキュメント版（自動テストサマリー、QC担当者向け）＋スプレッドシート版（手動テスト仕様書、社内規定フォーマット・書式/セル結合対応）の作成 → レビューを行う。ユーザーが「テスト仕様書を作って」「手動テストの仕様書が欲しい」「社内フォーマットのテスト仕様書にして」「テスト仕様書フェーズに進めて」と言ったら起動する。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch, WebSearch, AskUserQuestion, mcp__google-workspace__*, gws
---

# /dev-test-spec - テスト仕様書フェーズ

このスキルは**手順の逸脱を認めない標準手順書**として書かれている。判断に迷う箇所は「判断表」に従い、表にないケースは作業を止めてユーザーに確認する。**スクリプトが自動化している処理を、gws の生 batchUpdate で手動再現・手動パッチしてはならない**（書式のズレ・検算不能の原因になる）。

## 成果物の役割分担（2本立て）

| 成果物 | 形式 | 用途 | 記載内容 |
|---|---|---|---|
| **Googleドキュメント版** | Docs（原本コピー） | 自動テストのサマリーを社内 QC 担当者に見せる | 自動テスト（E2E/ユニット）のシナリオ一覧・実行方法・結果 |
| **スプレッドシート版** | Sheets（原本コピー） | 自動テストでカバーしきれない範囲を社内の人間が手動テストして QC 担当者に見せる | **手動テストのみ**（帳票出力の体裁目視、見た目の品質、移行データの目視突合など。分類基準は test-tier-model.md） |

### 原本・サンプル（コピー元 URL は変更しない）

| | 原本（コピー元） | 記入サンプル（完成形の見本） |
|---|---|---|
| Docs 版 | `https://docs.google.com/document/d/1dM1l1TUYPFCuce1UAqm4xS7OtMyXk4NQdb2Yuaupygs/edit` | `https://docs.google.com/document/d/1IrZBSHPTS0o59EGbFnEZVpIp9niE8Cp6xDNsiE-bhmE/edit` |
| Sheets 版 | `https://docs.google.com/spreadsheets/d/1AQU4HplC2LxrKfPQ2-ZTGP2JuLfa3yn6SVYb9UsS75o/edit` | `https://docs.google.com/spreadsheets/d/1nsJWMBE4IPDPXL9LzGYj-Ylhcz20bH8qr5T-4a1L310/edit` |

Sheets 版は**原本を Drive コピーしてから値を記入する**方式。レイアウト・書式・背景色・セル結合・非表示タブは原本コピーで自動的に保持され、記入・罫線・塗り分けはすべて `fill-test-spec.mjs` が行う。**Claude が個別セルを手で書式設定することはない。**

### 保管場所（固定・ユーザーに聞かない）

- 親フォルダ: **`01_案件`** = `11Z_lM-K3TYlN2m2XYyRl0XcSE0PL46jq`（共有ドライブ）
- この直下に案件フォルダ **`A_YYYYMMDD_<案件名>`** を新規作成し（YYYYMMDD は作成日、案件名は Issue タイトル準拠。例: `A_20260708_外国人情報にニックネームを追加する`）、Docs 版・スプレッドシート版の両方をその中に保存する
- 同名の案件フォルダが既にあればそれを使う（重複作成しない）

```bash
# 案件フォルダの存在確認（あれば id を控えて再利用）
gws drive files list --params '{"q":"'\''11Z_lM-K3TYlN2m2XYyRl0XcSE0PL46jq'\'' in parents and trashed=false","supportsAllDrives":true,"includeItemsFromAllDrives":true,"corpora":"allDrives","fields":"files(id,name)"}'
# 案件フォルダの新規作成
gws drive files create --params '{"supportsAllDrives":true}' \
  --json '{"name":"A_YYYYMMDD_<案件名>","mimeType":"application/vnd.google-apps.folder","parents":["11Z_lM-K3TYlN2m2XYyRl0XcSE0PL46jq"]}'
```

### 検証・本番環境の既定値（人材管理システム。plan JSON にこのまま使う）

| 環境 | plan フィールド | URL | アカウント（ID / Pass） | 権限 | 要否 |
|---|---|---|---|---|---|
| ローカル（実走用） | `localUrl` | 案件の docker compose 環境（例 `http://localhost:18091`。案件ごとに異なる） | `test@example.com / password` | テナント管理者 | - |
| 検証(stg) | `siteUrl` / `accounts` | `https://stg.example.com/` | `test@example.com / password` | テナント管理者 | 要 |
| 本番 | `prodSiteUrl` / `prodAccounts` | `https://app.example.com/` | `test@example.com / password` | テナント管理者 | 要 |

- **本番の `prodSiteUrl` / `prodAccounts` は必ず plan JSON に入れる**（本番確認テスト仕様書タブに反映される。空だと検証環境の値が残る）
- **`localUrl` は実走検証（F1.6）専用**。仕様書（Docs/Sheets）に載る検証環境 URL は `siteUrl`（stg）のまま。実走だけローカルに向ける（下記「実走環境の考え方」参照）
- 追加の権限（受入企業担当者等）でのテストが必要な案件では、上記に加えてユーザーに確認する

### 実走環境の考え方（stg マージ前が多い前提）

テスト仕様書は **stg にマージされる前**に作成することが多く、その時点では対象機能が stg に未デプロイ。そのため **実走検証（F1.6）はローカル環境（`localUrl`）を優先**する:

1. **`localUrl` があればローカルで実走**（feature ブランチを docker compose で起動した環境）。stg マージ前の標準ケース
2. `localUrl` が無く、対象機能が **stg（`siteUrl`）にデプロイ済み**ならそちらでもよい
3. どちらも使えない（ローカル未起動・stg 未デプロイ）→ 実走はスキップし、その旨を最終報告・引継書に明記

仕様書に記載する URL（`siteUrl`＝stg）と、実走する URL（`localUrl` 優先）は別物。**実走は本番（`prodSiteUrl`）に対しては絶対に行わない**。

## リファレンス

- **QC overlay 契約**: [../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)（組織固有の QC 観点の差し込み方。観点そのものは dev-flow に同梱しない）
- **テスト層モデル（自動／手動の振り分け）**: [../_shared/reference/test-tier-model.md](../_shared/reference/test-tier-model.md)（自動／手動の振り分け基準。overlay の有無に依存しない）

## 組織固有の QC 観点（overlay）

dev-flow は組織固有の品質観点を同梱しない。フェーズの開始時に overlay の適用状況を判定する。

```bash
bash <skill-dir>/../_shared/scripts/qc-overlay.sh --phase test-spec
```

- `overlay_applied` が `1` → `file` のパスを Read し、並んでいる観点をこのフェーズの追加レンズとして適用する
- `overlay_applied` が `0` → 観点を**自作せずスキップする**（組織の QC を dev-flow が発明してはいけない）

どちらの場合も **適用したかスキップしたかを1行報告する。黙って素通りしない。** `warnings` があれば添える。
判定が `overlay_present` ではなく `overlay_applied` を見ている理由を含む契約は
[../_shared/reference/qc-overlay.md](../_shared/reference/qc-overlay.md)。

overlay の有無にかかわらず、次の1点は必ず守る（誤送信は取り返しがつかない）:

- メール送信そのものが目的でないテストでは、**ダミーメールアドレスのドメインに `example.com` を使う**。
  実在ドメインを書くと誤送信と受信側の滞留を招く

## 手順

### F0. 引継書の読み込み

1. `ls -1 .agent/handover-*.md | tail -1` で最新の引継書を特定して Read する
2. 以下を控える（後続ステップの入力になる）: テスト結果（E2E件数）／Issue URL／PR URL／案件名

### F1. テスト計画の作成（自動/手動の分類）

**分類基準の正は [../_shared/reference/test-tier-model.md](../_shared/reference/test-tier-model.md)**。まずこれを Read し、その「振り分け例」に従う。場当たりな独自基準を作らない。

0. **`/dev-test-ledger` の 🟣 手動テストへ が既にある場合はそれを起点にする**。`.agent/test-ledger/<Issue番号>.md` の 🟣 セクションは「機械では合否判定できない」と判定済みの観点なので、手動テスト項目の第一候補になる（人が持ち込む。自動連携はしない）。

1. 実装済み機能を自動テストと手動テストに分類する。**判定は「機械が合否判定できるか」で決める**（「手間だから手動」は不可）:
   - **自動テスト（機能テスト＝自動含む）**: UI要素の表示、画面遷移、フォームバリデーション、CRUD操作、フィルタ動作、**権限別の表示/非表示の有無**、**レスポンシブでの要素の表示/非表示・並び替えの有無**、データ整合性の**結果値**検証
   - **手動テスト**: 帳票出力（Word/PDF）の**体裁・レイアウト崩れの目視**、ダッシュボードの**見た目の品質**（色・比率の主観評価）、権限画面の**レイアウトの見た目**、レスポンシブの**実機での見た目の自然さ**、移行データの**目視突合**、ユーザー視点チェック（分かりやすさ）
   - ⚠️ **権限・レスポンシブ・データ整合性を丸ごと手動にしない**。有無・結果値は自動、見た目・目視部分だけが手動（過剰手動化の防止。テスト層モデルのアンチパターン）
2. `.agent/test-plan-<機能名>.md` にテスト計画を書く（人間レビュー用）
3. 手動テスト項目を `.agent/test-spec-<機能名>.json` に構造化する（後述スキーマ厳守）
4. **JSON 作成後のセルフチェック**（すべて YES であること。このあと F1.5 のリントと F1.6 の実走検証を必ず通す）:
   - [ ] `siteUrl` / `prodSiteUrl` / `accounts` / `prodAccounts` に「検証・本番環境の既定値」を設定した（本番は必ず入れる）
   - [ ] stg マージ前で実走をローカルで行う場合は `localUrl`（案件の docker compose URL）を設定した
   - [ ] `groups[0]` は `no: "00"`・`title: "準備"` で、テストデータ作成手順が入っている
   - [ ] 最後のグループは「後片付け」で、テストデータ削除手順が入っている
   - [ ] 確認を伴う手順すべてに `expected` がある／操作だけの手順に `expected` がない
   - [ ] メールアドレスはすべて `example.com` ドメイン（誤送信と受信側の滞留を避ける）
   - [ ] グループ数が 9 以下（原本のブロック数上限）

### F1.5. 静的リント（必須・秒速。ERROR ありでは先へ進まない）

plan JSON 単体の機械チェック。手順参照（No.02 等）の整合・定義名（以下「X」とする）の未使用・後片付けの有無・連番・URL 既定値・example.com ドメイン（QC-T3）・表記揺れ・**文章規約違反（実装の概念名／内部識別子／実施者任せの逃げ表現／環境依存の場合分け。後述「手動テスト手順の文章規約」参照）** を検出する。

```bash
node <skill-dir>/scripts/lint-plan.mjs --plan .agent/test-spec-<機能名>.json
```

- **期待する出力**: `リント結果: ERROR 0 件 / WARN n 件`（exit 0）
- ERROR あり（exit 1）→ plan JSON を修正して再実行。**リントの指摘を無視して F2 に進むことを禁止する**
- WARN は1件ずつ内容を確認し、妥当な指摘なら plan JSON を直す。意図的なもの（例: 画面の実表記が「受け入れ企業」で揺れではない）ならそのまま進んでよいが、判断理由を最終報告に書く

### F1.6. 実走検証（シート生成前に1回。仕様書の精度を実画面で確認する）

**test-spec-walker エージェント**が Playwright で **実走環境**（`localUrl` があればそれ、無ければ `siteUrl`＝stg）の実画面を手順どおりに歩き、矛盾・手順抜け・表記差異を検出する。機能バグの合否判定はしない。**本番 URL（`prodSiteUrl`）では実走しない**。

0. **実走環境を決める**（「実走環境の考え方」に従う）: stg マージ前が多いので、**まずローカル環境（`localUrl`）を使う**。`localUrl` が無く対象機能が stg にデプロイ済みならそちらでもよい。
   - **前提: 対象機能が実走環境にデプロイ／起動済みであること**を先に確かめる（未反映だと全手順が実行不能に倒れる。エージェントもプリフライトで検出して即中断するが、起動前に分かるなら起動しない）。ローカル未起動なら `/dev-setup` で起動を促す
1. 実走環境にテストデータを作成・削除する副作用があるため、**実行前に AskUserQuestion で1回確認**する（環境が使用中の時間帯などはユーザーがスキップを選べる）
2. Agent ツールで `dev-flow:test-spec-walker` を起動し、plan JSON のパス（`localUrl` 含む）とレポート出力先 `.agent/reports/test-spec-walk-<機能名>.md` を渡す（`.agent/` に書けない環境ではエージェントが `~/.claude/test-spec-walk/` にフォールバックして実パスを報告する）。エージェントは実走 URL を `localUrl || siteUrl` で解決する
3. **準備（手順00）で作成するデータの入力画面も必ず実測する**。手順を歩くだけでは、準備手順に書いた項目名・選択肢が実画面と違っていても検出できない（実例: 帳票テンプレートの出力形式を「Word」と書いていたが、実際の選択肢は「PDF」「Excel」の2択だった）。作成画面を開き、**必須項目・選択肢の実表記**をすべて拾って plan JSON に反映する
4. レポートの指摘（表記差異・手順抜け・実行不能）を plan JSON に反映する。**表記は実画面が常に正**
5. plan JSON を修正したら F1.5（リント）から再実行。指摘 0 または対応済みになってから F2 へ
6. スキップした場合・実行不能が残った場合は、その旨と理由を最終報告と引継書に明記する

### F2A. Googleドキュメント版の作成（自動テストサマリー）— 標準手順

**記入はすべて `fill-test-spec-docs.mjs` が行う。Claude が gws の生 batchUpdate でタブを手動記入することを禁止する**（Sheets 版と同じ原則）。**「Docs の index 計算が高コスト」等を口実に、実施概要タブだけ埋めて他タブを原本プレースホルダーのまま放置することは指示違反として禁止**（スクリプトが4タブ全部を一括記入し、`--verify` が記入放置を検出する）。

#### D1. plan JSON に `docs` セクションを用意する（スキーマは後述）

- シナリオは **E2E spec ファイル（describe/test 名）から抽出**し、各シナリオに `purpose`（目的）と `flow`（自動テストの流れ・番号手順）を必ず書く。**グループ名＋件数の羅列だけの低粒度は禁止**（記入サンプルの粒度が基準。スクリプトのスキーマ検証でも弾かれる）
- **ユーザーストーリーテストの spec がある案件では、必ず scenarios（詳細形式）のセクションとして先頭に記載する**（機能テストは items＝テスト名列挙でよい）
- `items` のテスト番号は**ファイル内の通し番号**（グループを跨いで 1..N 継続。サンプル準拠）。グループ見出し（●）間の空行はスクリプトが自動挿入するので書かない
- `summaryGroups` は画面/機能別に「〜すること」形式の確認項目を列挙する

#### D2. Docs 原本をコピーする（B1 の承認にまとめてよい）

```bash
gws drive files copy --params '{"fileId":"1dM1l1TUYPFCuce1UAqm4xS7OtMyXk4NQdb2Yuaupygs","supportsAllDrives":true}' \
  --json '{"name":"【人材管理】総合テスト仕様書_<案件名>","parents":["<FOLDER_ID>"]}'
```

返却 JSON の `id` を `<DOCID>` として控える。

#### D3. dry-run で挿入内容を確認する

```bash
node <skill-dir>/scripts/fill-test-spec-docs.mjs --doc <DOCID> --plan .agent/test-spec-<機能名>.json --dry-run
```

- **期待する出力**: `dry-run: 挿入 N 箇所 / リクエスト N 件（書込は行っていません）`
- 「ドキュメント構造が原本と一致しません」→ 原本が改版された可能性。中止してユーザーに報告

#### D4. 本実行する（検算込み）

```bash
node <skill-dir>/scripts/fill-test-spec-docs.mjs --doc <DOCID> --plan .agent/test-spec-<機能名>.json --verify
```

- **期待する出力**: `検算 OK: 全アンカーの直後に本文があります` と、末尾にドキュメント URL
- 検算は4タブ全セクションの記入を照合する（記入放置はここで検出される）
- 記入済みアンカーは自動スキップされる。作り直しは `--force` ではなく**原本の再コピー**（重複挿入防止）

#### D5. PDF でレイアウトを目視確認する（必須・スキップ禁止）

```bash
gws drive files export --params '{"fileId":"<DOCID>","mimeType":"application/pdf"}' -o test-spec-docs.pdf
pdftoppm -png -r 150 test-spec-docs.pdf docs_page   # 全ページ画像化して Read で確認
```

チェックリスト（**記入サンプルの Docs と見比べながら**1項目ずつ確認）:

- [ ] **4タブすべてに本文が入っている**（原本プレースホルダー（H3 準備・空の見出し）が残っていたら NG）
- [ ] 見出し階層がサンプルと同じ（環境準備は H4 1.1/1.2/1.3、実行方法はコマンド別に H5）
- [ ] 箇条書きにすべきものが bullet になっている／本文が誤って見出しスタイルになっていない
- [ ] シナリオ一覧にシナリオごとの「目的」「自動テストの流れ」がある（件数の羅列だけなら NG）
- [ ] ログイン情報の各行（サイトURL/ログインID/パスワード/権限）に値が入っている
- [ ] 本番確認タブに本番 URL・アカウント（未確定なら「デプロイ後確定」）が明示されている

1つでも NG → 手動パッチせず、plan JSON かスクリプトの問題として扱い、原本再コピーからやり直す。

### F2B. スプレッドシート版の作成（手動テスト仕様書）— 標準手順

**このセクションは上から順に実行する。ステップの省略・入れ替え禁止。**

#### B1. コピー実行の承認を取る（AskUserQuestion・必須）

Drive への書込のため、案件フォルダ名（`A_YYYYMMDD_<案件名>`、保管場所は `01_案件` 固定）とファイル名を提示して1回確認する。承認前にコピーしない。案件フォルダが未作成ならこの承認でフォルダ作成も含めて確認する。

#### B2. 原本をコピーする

```bash
gws drive files copy --params '{"fileId":"1AQU4HplC2LxrKfPQ2-ZTGP2JuLfa3yn6SVYb9UsS75o","supportsAllDrives":true}' \
  --json '{"name":"【人材管理】総合テスト仕様書_<案件名>","parents":["<FOLDER_ID>"]}'
```

- 返却 JSON の `id` を `<SSID>` として控える
- **期待する出力**: `id` を含む JSON。エラーが出たら中止してユーザーに報告

#### B3. dry-run で生成内容を確認する

```bash
node <skill-dir>/scripts/fill-test-spec.mjs --spreadsheet <SSID> --plan .agent/test-spec-<機能名>.json --dry-run
```

- **期待する出力**: stderr 末尾に `dry-run: 行挿入 N 件 / 値レンジ N 件 / 書式系 N 件 …（書込は行っていません）`
- エラーで止まった場合 → 下の「トラブルシューティング表」に従う。**スクリプトのエラーを回避するために gws を直接叩かない**

#### B4. 本実行する（検算込み）

```bash
node <skill-dir>/scripts/fill-test-spec.mjs --spreadsheet <SSID> --plan .agent/test-spec-<機能名>.json --verify
```

- **期待する出力**: `検算 OK: 値・観点結合・罫線・結果欄背景とも plan と一致` と、末尾にシート URL
- `検算 NG` が出た場合 → 手で直さない。トラブルシューティング表へ

#### B5. PDF で見た目を目視確認する（必須・スキップ禁止）

罫線・結合・塗り分けは JSON の検算だけでは見落とすため、必ず画像で確認する。

```bash
gws drive files export --params '{"fileId":"<SSID>","mimeType":"application/pdf"}' -o test-spec.pdf
pdftoppm -png -f 2 -l 2 -r 800 -x 500 -y 580 -W 3600 -H 1300 test-spec.pdf spec_zoom   # 機能テスト仕様書タブの左上領域
```

生成された `spec_zoom-*.png` を Read し、**記入サンプル（上記 URL）と見比べながら**次のチェックリストを1項目ずつ確認する:

- [ ] **罫線の種類がテンプレートと同じ**（罫線は黒実線だけではない）: No/手順/期待列以降は黒実線グリッド、検証内容の下位区切り（C〜E 列の内側縦線）は**灰色破線**、右端2ブラウザ枠（AY〜BJ）は**横線のみ**（縦線なし）
- [ ] **B〜E 列の横線は見出し行の前後にしか黒線がない**（ブロック内部の横線は透明＝見えない。手順行同士の間に黒い横線が出ていたら NG）
- [ ] **A 列には黒線が一切ない**（見出し行の左隣も含めて透明。表の左端の縦線は B 列の左辺）
- [ ] 挿入した行が既存の手順行と見分けがつかない（罫線・背景とも同じパターン）
- [ ] 検証観点セル（D:E）が1行単位で結合され、結合の右側の縦線も見える
- [ ] **観点セルの長文が折り返されて全文見える**（セル幅で途中で切れていたら NG）
- [ ] **「期待する結果」列（H）の長文が折り返されて全文見える**（右の結果記入欄へはみ出していたら NG。原本テンプレは H 列の折り返し設定が行ごとに不統一なので必ず目視する）
- [ ] **C〜H 列のデータ行（R15 以降）が左揃え**／R14 の見出し行は中央揃えのまま
- [ ] `expected` が空の行は「期待する結果」列（H）から右端（BJ）まで灰色／`expected` がある行は白
- [ ] ブロック見出し行（大項目 No＋タイトル）がオレンジ帯のまま
- [ ] 「機能テスト(サマリー)」など hideTabs 指定のタブが PDF に出ていない

1つでも NG → トラブルシューティング表へ。**目視で NG を見つけたのに「概ね良さそう」で通すことを禁止する。**

#### B6. 再実行のルール（重要・暗黙知の明文化)

- **書込みを1回でも追加実行したら、B4 の検算と B5 の目視は無効になる。必ず B4→B5 をやり直す**（目視確認は常に「最後の書込みの後」）
- `--force` を使ってよいのは「**同じ plan JSON で、人間がまだ1文字も編集していないシート**」への再適用のみ
- 人間がシートを編集した後の再実行は禁止。修正が必要なら B2 から新しいコピーでやり直す（旧コピーはユーザー確認のうえゴミ箱へ）

#### B7. 本番確認テスト仕様書タブの差し替え確認

スクリプトが機能テストタブの複製＋URL/アカウント上書きまで自動で行う。plan JSON に既定値（`prodSiteUrl: https://app.example.com/` と `prodAccounts`）を入れてあるので、本番確認タブのサイト URL が本番 URL に差し替わっていることを `--verify` 後に values get で1回確認する。

### F5. レビュー

1. ユーザーに **両方の URL**（Docs 版・スプレッドシート版）を共有してレビュー依頼
2. 修正の反映方法は次の判断表に従う:

| 修正の種類 | 対応 |
|---|---|
| 手順・期待結果の文言変更、行の追加/削除 | plan JSON を修正 → B2 から新コピーでやり直し（B3〜B5 込み） |
| 誤字1〜2文字などの微修正（ユーザー了承時のみ） | `gws sheets spreadsheets values update` で該当セルのみ。書式は触らない |
| 罫線・色・結合の見た目の問題 | スクリプトのバグとして扱う。手動パッチせず、ユーザーに報告して修正方針を確認 |

### F6. 引継書更新

1. `.agent/handover-YYYYMMDD-HHMM[-issue{番号}].md` を**新規作成**（既存ファイルの上書き禁止）
2. 記載必須項目: 両テスト仕様書の URL／テストケース件数（自動/手動の内訳）／レビュー状況／次フェーズ（qa）への引継事項（正準順は verify → test-spec → qa → 台帳 → ship）
3. ユーザーに「/clear して QA フェーズ（/dev-qa）に進めますか？」と確認

## 手動テスト手順の文章規約（groups の書き方）

**読者は非エンジニアのテスト実施者**。実施者が仕様書だけで完遂でき、開発者に聞き返さずに済む文章にする。以下は例外なく守る。**F1.5 の静的リントが機械検出できるものは ERROR で落ちる**（`wording-*`）。

### 用語

- **英語（識別子・関数名・クラス名・テーブル名・シード関数名）を書かない**。`formatForeignerDisplayName` `CreateReceiptTemplates` `Foreigner` `Receipt` `BE seed` などは全て不可
- **実装の概念名を持ち込まない**: `case` `precondition` `Group` `Step` `process==1` などは書かない
- **手順の参照は「手順NN No.MM」形式**（例: 「手順00 No.04 で登録したテンプレート」）。`Group00 Step04` は不可
- 画面の名前・ボタン名・項目名は**実画面の日本語表記をそのまま**使う（F1.6 の実走検証で確認した表記が正）
- 仕様の理由・背景の説明を手順文に混ぜない（「（〜を必須項目として要求するため）」等の補足は削る）

### 環境依存の分岐を書かない

- **「○○が無い場合はスキップ」「環境の投入状況に依存」を書かない**。必要な状態は手順00（準備）で作り、手順NN（後片付け）で必ず戻す
- 準備で作れないもの（開発側が用意すべきテストデータ・ファイル等）がある場合は、**仕様書作成の時点で開発側と調整し、入手方法を準備手順に明記**する。「環境担当に確認する」と書いて実施者に丸投げしない
- 準備手順は**画面操作だけで完結**させる。DB 投入・シードスクリプト・API 直叩きを前提にしない

### 後始末を決めきる

- **「開発側の判断に委ねる」「本仕様書のスコープ外」で逃げない**
- 準備で作成したデータ（利用者・テンプレート・添付ファイル等）は、**後片付けで漏れなく削除する手順を書く**
- 「登録まで進めた場合は削除」のような条件分岐を作らない。手順側で「登録は実行しない」と確定させ、後片付けを一本道にする

### 検証内容

- 実装の内部挙動ではなく、**実施者が画面・ファイル上で目視できること**だけを期待結果に書く
- 環境に左右される検証（フォント埋め込みの有無など）は書かない

## テスト計画 JSON スキーマ（`.agent/test-spec-<機能名>.json`）

```json
{
  "siteUrl": "https://stg.example.com/",
  "localUrl": "http://localhost:18091",
  "accounts": [
    { "idPass": "test@example.com / password", "role": "テナント管理者", "required": "要" }
  ],
  "prodSiteUrl": "https://app.example.com/",
  "prodAccounts": [
    { "idPass": "test@example.com / password", "role": "テナント管理者", "required": "要" }
  ],
  "overview": {
    "author": "北村",
    "issueUrl": "https://github.com/.../issues/NNN",
    "prUrls": ["https://github.com/.../pull/NNN"]
  },
  "groups": [
    {
      "no": "00", "title": "準備",
      "cases": [
        { "viewpoint": "", "steps": [ { "content": "テナント管理者でログイン" } ] }
      ]
    },
    {
      "no": "01", "title": "帳票出力機能で出力したWordファイルの確認",
      "cases": [
        {
          "viewpoint": "必須項目以外デフォルトの場合の帳票出力結果の検証",
          "steps": [
            { "content": "以下の内容で新規の定期面談結果を追加する。…" },
            { "content": "帳票出力ボタンより出力しWordで確認する。", "expected": "・入力内容が反映されている\n・文字化けやレイアウト崩れがない" }
          ]
        }
      ]
    },
    { "no": "02", "title": "後片付け", "cases": [ { "steps": [ { "content": "テストデータを削除する", "expected": "正常に削除される" } ] } ] }
  ],
  "hideTabs": ["機能テスト(サマリー)"],
  "docs": {
    "author": "北村",
    "requirementUrls": ["https://github.com/.../issues/NNN"],
    "sourceUrls": { "frontend": ["https://github.com/.../pull/NN"], "backend": ["https://github.com/.../pull/NN"] },
    "e2eUrls": ["e2e/tests/functional/<機能名>-functional.spec.ts", "手動テスト仕様書（スプレッドシート版）: <URL>"],
    "summaryGroups": [
      { "title": "利用者追加画面の確認", "items": ["ニックネーム欄が表示されること", "50文字まで入力できること"] }
    ],
    "resultSummary": {
      "auto": { "total": 24, "breakdown": [ { "label": "機能テスト", "count": 24 } ] },
      "manual": { "total": 13, "breakdown": [ { "label": "帳票実ファイル確認", "count": 5 } ] }
    },
    "envPrerequisites": ["Node.js がインストール済みであること", "フロントエンド・バックエンドが起動していること"],
    "envSetup": ["$ cd example-frontend", "$ npm ci", "$ npx playwright install chromium"],
    "runCommands": [ { "label": "全テスト実行", "command": "$ npx playwright test --config=e2e/playwright.config.ts e2e/" } ],
    "scenarioSections": [
      {
        "header": "機能テスト（24テスト）", "file": "e2e/tests/functional/<機能名>-functional.spec.ts",
        "scenarios": [
          { "name": "追加画面でニックネームを登録できる", "purpose": "登録フローの確認",
            "flow": ["追加画面に遷移", "ニックネームを入力して保存", "検証: 一覧に表示される"] }
        ]
      }
    ],
    "testResult": ["24 件 全 PASS（YYYY-MM-DD 実行、<環境名>）"],
    "manual": { "specUrl": "<スプレッドシート版URL>", "summary": ["全13ケース（内訳...）", "実施結果はスプレッドシート版に記入"] },
    "prod": { "envPrep": ["本番 URL に対して同一 E2E を実行"], "testResult": ["本番デプロイ後に実施し記入"] }
  }
}
```

記入ルール（サンプル実測に準拠。すべて機械的に従う）:
- `groups[].no` は `00`（準備）始まりのゼロ埋め2桁連番。最初のグループは「準備」（テストデータ作成）、最後は「後片付け」（テストデータ削除）
- `viewpoint`（検証観点）は各ケースの先頭手順行に入り、D:E セルが自動で結合される。準備・後片付けなど観点不要なら空文字または省略
- `steps[].expected` は確認を伴う手順にだけ書く。**expected が空の行は結果欄（H〜BJ列）が自動で灰色**になる（実施者が結果を書かない行の印）
- 手順番号はグループ内 `01` からの連番をスクリプトが自動採番する（JSON に番号は書かない）
- 実施日・担当・結果の列は手動テスト実施者が書くため空のままにする
- `hideTabs` は使わないタブ名を列挙（通常は `["機能テスト(サマリー)"]`。性能テストをやる案件では「性能テスト仕様書」を隠さない＝リストに入れない）
- `docs` セクション（Docs 版の入力）: `scenarioSections[].scenarios[]` は **name・purpose・flow の3点セットが必須**（E2E spec の describe/test から抽出して書く。グループ名＋件数だけの羅列はスキーマ検証で弾かれる）。`prod` を省略した場合、本番確認タブには既定の「デプロイ後確定」プレースホルダーが入る

## トラブルシューティング表

| 症状 | 原因 | 対応 |
|---|---|---|
| `中止: 機能テスト仕様書タブの手順行に既に記入があります` | コピー直後でないシートを対象にした、または二重実行 | 対象 `<SSID>` が B2 で作ったコピーか確認。同じ plan の再適用なら B6 のルールを満たす場合のみ `--force` |
| `グループ数 N がテンプレートのブロック数 9 を超えています` | groups が多すぎる | 関連グループを統合して 9 以下にする。統合できない場合はユーザーに相談 |
| `アカウント数 N がテンプレートの行数 5 を超えています` | accounts が多すぎる | 主要5アカウントに絞り、残りは備考運用にするかユーザーに相談 |
| `検算 NG: … 罫線が欠けています / 背景が期待と不一致` | スクリプトのバグ、または実行途中の失敗 | 手動で直さない。新しいコピー（B2）からやり直し、再発するならスクリプトのバグとしてユーザーに報告 |
| `検算 NG: … 手順が不一致` | plan JSON と実行に使った JSON が違う、または実行後に誰かが編集 | plan JSON を確認して B2 からやり直す |
| `テンプレート解析失敗: ヘッダ行が見つかりません` | 原本の構造が変わった | 作業を止めてユーザーに報告（スクリプトの座標解析の更新が必要） |
| gws がエラー（認証・権限） | OAuth 失効・対象への権限なし | 作業を止めてユーザーに報告（`gws` の再認証はユーザー操作） |
| lint-plan が ERROR で exit 1 | 手順参照の不整合・example.com 以外のメール等 | plan JSON を修正して再実行。リント無視での続行は禁止 |
| 実走検証で実走環境に接続できない／ログインできない | ローカル未起動・stg 未デプロイ・アカウント変更 | `localUrl` のローカル環境なら `/dev-setup` で起動を促す。それでも不可ならスキップ可否をユーザーに確認（スキップ時はレポート・引継書に明記） |
| `pdftoppm: command not found` | poppler-utils 未導入 | コンテナ内なら `bootstrap-add apt poppler-utils`、それ以外は `sudo apt-get install poppler-utils` |

## 禁止事項（このスキルにおける絶対ルール）

1. **スクリプトを迂回して gws の生 `batchUpdate` で書式（罫線・結合・背景色）を手動設定しない**。見た目の問題はすべてスクリプト修正で解決する
2. **B5 の PDF 目視をスキップしない**。検算 OK は目視の代わりにならない
3. **書込み後に目視せず完了報告しない**。最後の書込みより前の確認結果は無効
4. **人間が編集を始めたシートに `--force` で再実行しない**（人の記入が消える）
5. 原本・サンプルの URL を書き換えない／原本自体に書き込まない
6. **実走検証（test-spec-walker）を本番 URL（`prodSiteUrl`）に対して行わない**。実走はローカル（`localUrl`）または検証環境（`siteUrl`）のみ
7. **F1.5 の静的リントを ERROR ありのまま素通りしない**（リントはシート生成の前提条件）
8. **Docs 版のタブを記入放置しない**。「index 計算が高コスト」等を口実に実施概要タブだけ埋めて完了扱いにすることは指示違反（記入は fill-test-spec-docs.mjs が全タブ一括で行い、--verify が放置を検出する）
