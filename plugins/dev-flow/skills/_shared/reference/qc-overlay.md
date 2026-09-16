# QC overlay — 組織固有の品質観点を外から差し込む契約

dev-flow は汎用の開発フローであり、**組織ごとの品質観点（QC チェックリスト）を同梱しない**。
組織固有の観点は overlay として外から差し込む。overlay が無くても dev-flow は完全に動作し、
**観点が1つも適用されなかったことを必ず報告する**。

## 境界

- **入力境界**: `~/.cc-plugins/overlay/qc/` 配下の `manifest.json` とフェーズ別 md。
  環境変数 `CC_PLUGINS_OVERLAY_DIR` で差し替えられる（テストと複数組織の切り替え用）。
  このディレクトリは plugin の外にある。plugin 外参照は原則禁止だが、`~/.cc-plugins/.env` と
  同じ「ユーザー個別の設定ファイル」枠の例外として扱う。
  - クラウドセッションでは `$HOME` がセッションごとにリセットされるため、この配置がそのままでは
    届かない。届け方は2通り: ①`cloud-env-setup` の `scripts/render_qc_overlay_snippet.sh` で
    Setup script に埋め込む（手動貼り付け、常設リポジトリ不要）②overlay を含む別リポジトリを
    セッションに付けたうえで環境変数 `CC_PLUGINS_OVERLAY_SOURCE_SUBPATH`（例:
    `plugins/proseeds-overlay/overlay/qc`）を設定し、`_shared/scripts/qc-overlay-cloud-sync.sh`
    が SessionStart hook から自動で同期する（貼り直し不要・常に最新だが、そのリポジトリを
    毎回セッションに付ける必要がある）。使い分けは `cloud-env-setup` の SKILL.md 参照
- **出力境界**: overlay を参照する各スキル／エージェントは、次の1文を自分の節に
  **そのまま（byte-identical で）**持ち、実行時にそれを守る:

  <!-- qc-overlay:report-line -->
  **適用したかスキップしたかを1行報告する。黙って素通りしない。**
  <!-- /qc-overlay:report-line -->

  未適用の行は統合レポートから消さず `⏭` で残す
  （消すと軽い経路を通ったことが後から監査できない。`dev-self-review` の未起動行と同じ扱い）。
  この1文を「だいたい同じ」言い方に崩すと、検査が語の存在チェックに退化して
  **義務を消しても通る**。実測で7消費側のうち4つが素通りした。
- **責務境界**: dev-flow は overlay の**存在確認・読み込み・報告**だけを持つ。
  観点の中身・正しさ・組織固有の判断は overlay 提供側の責務であり、dev-flow は検証しない。

## ディレクトリ構成

**ファイル名は `<フェーズ名>.md` 固定**。manifest でファイル名を差し替えられるようにすると、
判定器は差し替え先を見るのに agent 側はハードコードした `<phase>.md` を見る、という
**正が2つある状態**になる（判定器が `applied=1` を返しているのに agent は「未適用」と報告する）。

```
~/.cc-plugins/overlay/qc/
├── manifest.json      # 必須。reviewer_agent を宣言する
├── plan.md            # 要件定義フェーズの観点
├── impl.md            # 実装・コードレビューの観点
├── test-spec.md       # 手動テスト仕様書作成の観点
├── verify.md          # 検証（クロスブラウザ・性能・セキュリティ）の観点
├── qa.md              # QA（ブラウザ自律探索後の評価）の観点
├── ship.md            # リリース前最終チェックの観点
└── test-model.md      # 自動／手動の振り分けに対する組織固有の注記
```

`manifest.json`:

```json
{
  "name": "<組織名> QC overlay",
  "version": "1.0.0",
  "reviewer_agent": "<plugin>:<agent>"
}
```

`reviewer_agent` は dev-qa の観点別評価に追加する1体を `<plugin>:<agent>` 形式で指定する。
**接頭辞なしでは名前解決に失敗する**（`~/.claude/agents/` の同名コピーに解決される事故がある）。
省略または空なら dev-qa は追加レンズ無しの3並列で実施し、未起動を報告する。

## 使い方

```bash
bash skills/_shared/scripts/qc-overlay.sh --phase plan
```

JSON 1行を stdout に返す:

```json
{"phase":"plan","overlay_present":1,"overlay_applied":1,"file":"/home/<user>/.cc-plugins/overlay/qc/plan.md","items":8,"reviewer_agent":"acme-overlay:qc-reviewer","warnings":[]}
```

| キー | 意味 |
|---|---|
| `overlay_present` | `manifest.json` が読めたか |
| `overlay_applied` | **観点が1件以上あるフェーズファイルを読めたか**。判定の本体はこちら |
| `items` | 数えた観点の件数（表のデータ行＋箇条書き行） |
| `file` | 読むべきフェーズファイル（`<overlay-dir>/<phase>.md`）の絶対パス。`overlay_applied=0` なら空文字 |
| `reviewer_agent` | dev-qa が追加起動する agent 名。未指定なら空文字 |
| `warnings` | 音を立てるべきことの列挙。空配列なら異常なし |

`overlay_applied=1` のときだけ `file` を Read して観点を適用する。`0` のときは観点を自作せず、
スキップしたことを報告する。**観点を推測で埋めてはいけない**（組織の QC を dev-flow が発明することになる）。

## 判定材料を `overlay_present` ではなく `overlay_applied` にしている理由

overlay の配布物は雛形としてコメントだけ・中身が空の状態で置かれうる。
`manifest.json` が読めたかどうかで判定すると、**空の雛形を置いた時点で警告が消える**。
観点は1件も適用されていないのに「overlay あり」として静かに通過する。

これは `assess-change-size.sh` が `conf_effective`（conf を読めたか）ではなく
`conf_applied`（設定が1つでも実際に効いたか）で判定しているのと同じ理由で、
あちらは配布テンプレートがコメントのみで届くため `cp` がそのまま通ると警告が消える、という
実測から来ている。ここも同型の穴があるので同じ方式を採る。

## 観点の数え方

フェーズファイル内の次の行を観点として数える。

- markdown 表のデータ行（区切り行と見出し行を除く）
- 箇条書き行（`-` `*` `+` 始まり）

除外するもの:

- コードフェンス（``` ）の内側
- HTML コメントの行
- 見出し行

表の見出し行は「次の行が区切り行であること」で判別して除外する。
**見出しと区切りだけの空テーブルを置いても `items=0`** になり、警告が出る。
これが上記の穴を実際に塞いでいる箇所なので、数え方を緩めてはいけない。
