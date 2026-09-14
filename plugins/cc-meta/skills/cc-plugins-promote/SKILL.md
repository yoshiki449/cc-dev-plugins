---
name: cc-plugins-promote
description: ローカル ~/.claude/skills/ と cc-plugins marketplace の整合性を保ち、新規スキルの移植判断・移植処理・ローカル保持マーカー管理を担う。skill-creator スキルで新規スキルを作成した直後、~/.claude/skills/ に新規ディレクトリが出現している状況、ユーザーが「未移植スキル」「cc-plugins整理」「移植判断」「移植して」「ローカル保持」と言った場面で必ず使う。スラッシュコマンド `/promote-check` `/promote-skill` `/mark-keep` を併用する。
---

# cc-plugins-promote

cc-plugins marketplace の **メンテナンス専用スキル**。新規スキルを作成した瞬間に「忘れずに cc-plugins に移植判断する」運用を支える。

## このスキルを起動するタイミング

以下のいずれかに該当したら、ユーザーから明示的に呼ばれなくても**自発的に**起動を提案する：

1. **skill-creator スキルでスキルを作成・完成宣言した直後**
2. ユーザーが「未移植チェック」「cc-plugins整理」「移植判断」「ローカル保持」「.cc-plugins-keep」などの語を口にした
3. セッション開始時に `~/.claude/skills/` を ls して、最終更新が新しいディレクトリが見つかった

## 状態モデル

各ローカルスキルは以下の3状態のいずれか：

| 状態 | 判定条件 | 対応 |
|---|---|---|
| **未判定 (UNJUDGED)** | ローカルにあり、`.cc-plugins-keep` 無し、cc-plugins にも未登録 | `/promote-check` で検出される |
| **ローカル保持 (LOCAL_KEEP)** | ローカルにあり `.cc-plugins-keep` あり | 検出から除外、ローカル運用 |
| **移植済み (PROMOTED)** | ローカルになく、cc-plugins/plugins/*/skills/ にある | 検出対象外 |

シンボリックリンク（`gws-*` などの外部由来）は自動的に除外される。

## ワークフロー

### Step 1. 未判定の検出

```
/promote-check
```

中身は `scripts/list_unpromoted.py` を呼ぶだけ。出力例：

```
=== 未判定スキル 3件 ===
  - my-new-skill
      path: /home/node/.claude/skills/my-new-skill
  - ...
```

### Step 2. 判断軸4軸で1つずつ仕分け

各未判定スキルに対し、以下を尋ねる：

| 軸 | 移植推奨 | 据え置き |
|---|---|---|
| A. 複数環境で使うか | 別マシン／Cowork でも欲しい | このマシン限定 |
| B. 機能の安定度 | 動作確定・壊したくない | 試作・頻繁書き換え |
| C. 業務固有度 | 業務固有でも社内で使い回す | 1案件限定の使い捨て |
| D. 配布したい先がある | 別環境／同僚 | 完全に個人ローカル |

- **移植する判定** → Step 3
- **ローカル保持判定** → Step 4
- **判断保留** → 次のスキルへ（次回 `/promote-check` で再度出てくる）

### Step 3. 移植処理

```
/promote-skill <skill-name> [<plugin-category>]
```

`<plugin-category>` 未指定なら、既存カテゴリを並べてユーザーに選ばせる。新規カテゴリも作成可。

必ず `--dry-run` でプレビュー → 承認 → 本実行 → git commit 承認 → push → `/reload-plugins` 案内、の順を守る。

### Step 4. ローカル保持マーカー

```
/mark-keep <skill-name>
```

これで `~/.claude/skills/<name>/.cc-plugins-keep` 空ファイルが置かれ、`/promote-check` の対象から除外される。

判定を撤回する場合：

```
/mark-keep <skill-name> --unset
```

## カテゴリの目安

スキル名・機能からカテゴリを推定するヒント：

| カテゴリ | 用途 | 例 |
|---|---|---|
| `kintone-tools` | kintone 連携・レコード操作 | kintone-record-builder |
| `cc-meta` | cc-plugins 自身の管理 | このスキル自身 |
| `daily-ops` | 日次運用（朝夕の振り返り、日報） | morning / evening / nippou-writer |
| `writing-utils` | 文章作成・編集系 | stop-ai-slop-jp / promo-site-structure |
| `hr-tools` | 人事・採用・面接系 | 採用面接の記録整形など |
| `<org>-internal` | 社内ナレッジ専用（組織ごとに1つ） | 社内規程の参照・更新など |

迷ったらユーザーに `AskUserQuestion` で選ばせる。

## 注意

- **不可逆操作**（ローカル削除、commit）を伴うので、必ず確認を挟む
- 1度に大量に処理しない（1スキルずつ）
- skill-creator 本体は触らない（公式 plugin、更新で消える）
- 北村さんの当初要望「**入力済みフィールドを構造的に保護**」のような汎用設計思想を、cc-plugins-promote 自身も踏襲する（machine-readable な状態管理＋ヒューマンインザループ承認）

## 関連ファイル

- `scripts/list_unpromoted.py`: 状態分類ロジック
- `scripts/promote.py`: 移植実行ロジック
- `scripts/mark_keep.py`: マーカー設置／解除
- `cc-plugins/README.md`: 全体運用ドキュメント
