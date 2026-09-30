---
name: ci-standard
description: GitHub Actions の CI を標準構成（PR・push は lint / unit のみ、E2E は週次と手動、E2E 結果を Google Chat に通知、docs だけの変更では起動しない）に揃える、または既存の workflow が標準に合っているかを判定するスキル。本番影響の大きいリポジトリは理由付きで例外にできる。ユーザーが「CI を標準構成にしたい」「GitHub Actions の実行量・コストを減らしたい」「E2E を週次にしたい」「E2E の結果を Google Chat に通知したい」「CI が標準に合っているか確認して」「ci-standard」と言ったとき、または /dev-setup の B5.6 から呼ばれたときに使う。
---

# /ci-standard — GitHub Actions の標準構成

## 何をするスキルか

CI の**起動条件・E2E の隔離・結果通知・timeout**だけを標準化する。lint や unit の中身（スタック固有）には触れない。

| # | 標準 | 判定ルール |
|---|---|---|
| 1 | docs 系だけの変更（`**/*.md` `docs/**` `.agent/**` `.claude/**`）では起動しない。コードの変更は取りこぼさない | R1 |
| 2 | `concurrency` は PR 番号・commit 単位。キャンセルは PR のみ（連続マージで main の検証が消えない） | R2 |
| 3 | E2E は週 1 回の定期実行（`schedule`）と手動実行（`workflow_dispatch`）だけ。PR・push では走らない | R3 R4 |
| 4 | E2E の結果を `notify-e2e` job が Google Chat に通知する（失敗・前段失敗による未実行も通知） | R5 |
| 5 | 全 job に `timeout-minutes`（1〜30 分） | R6 |
| 6 | E2E の前段 job（lint / unit など）は PR・push で毎回走り、E2E はその成功後にだけ走る | R7 R8 |

根拠・実測・踏んだ落とし穴は `references/rationale.md`。

## 例外にする基準（本番影響が大きいリポジトリ）

次のいずれかに当たるなら、標準を外して PR でも E2E を走らせる。**例外にするかどうかは本人に確認して決める（Claude が決めない）。**

- main へのマージで本番に自動デプロイされる
- 顧客・外部ユーザーに公開されている
- 金銭・個人情報・認可境界を扱う変更が日常的にある
- ブランチ保護で E2E の check が必須になっている

宣言は workflow の冒頭コメントに理由を書く。

```yaml
# ci-standard-exception: 本番へ自動デプロイされるため PR でも E2E を必須にする
```

例外で免除されるのは R3〜R5・R7・R8（E2E まわり）だけ。R1（docs スキップ）・R2・R6 は例外でも守る。理由が空なら R9 で不適合になる。

## 使い方

### 判定する（既存リポジトリ）

```bash
python3 <skill-dir>/scripts/validate_ci.py .github/workflows/ci.yml
```

終了コード: `0`=適合（警告は出うる）/ `1`=不適合（`[NG] Rn` の行に理由）/ `2`=読み込みエラー。PyYAML が必要（`pip install pyyaml`）。`[警告] R0` は標準の印（`# ci-standard: v1`）が無い、または版が古いことを示す。

### 新規リポジトリに置く

1. `<skill-dir>/templates/ci-standard.yml` を `.github/workflows/ci.yml` にコピーする
2. `TODO(ci-standard)` の箇所（ブランチ名、lint / unit / E2E の実コマンド、E2E に必要な services）を埋める
3. 判定を実行して適合を確認する

### 既存リポジトリに適用する

**workflow を書き換える前に、差分を見せて本人の承認を取る。** 承認後の手順:

1. 現行の job 構成を読み、前段 job（lint / unit など）の名前を控える
2. `on:`（`paths-ignore` `schedule`）と `concurrency` をテンプレートに合わせる
3. E2E job に `if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'` と、前段 job への `needs` を付ける。前段 job に `if:` は付けない
4. `notify-e2e` job を**テンプレートからそのままコピー**する（スクリプトは書き換えない。`needs` だけ前段 job 名に合わせる）
5. 全 job に `timeout-minutes` を付ける（実測の最長の 3〜4 倍が目安）
6. 冒頭に `# ci-standard: v1` を入れる
7. 判定を実行し、`actionlint` があればそれも通す
8. README などに「CI が走る条件」を書く。E2E の不具合検知が最大 1 週間遅れること、UI・認証・DB スキーマを変える PR はマージ前に *Run workflow* で E2E を手動実行することを含める
9. Secret の登録を本人に依頼する（下記）

**先に必須チェックを確認する。** ブランチ保護で required status checks に E2E や docs 系 PR の check を指定していると、起動しない check が pending のままになりマージできない。その場合は `paths-ignore` をやめ、変更検知 job と集約 job の方式に切り替える。

## 通知先（Google Chat）

- **推奨: 全リポジトリを 1 つのスペース（1 つの Webhook）に集約する。** 週次通知は 1 リポジトリにつき週 1 件で、通知本文の先頭にリポジトリ名（`owner/repo`）が入るため、集約しても区別できる。設定は 1 回で済み、失敗が 1 か所に並ぶ。
- **別スペースにするのは、閲覧者を分けたいとき**（顧客案件など）。コードの変更は不要で、そのリポジトリの Secret の値を別スペースの Webhook にするだけ。
- Secret の名前は全リポジトリで `GOOGLE_CHAT_WEBHOOK_URL` に揃える。
- 個人アカウントのリポジトリには組織向けの共有 Secret が使えない可能性が高い。リポジトリごとに *Settings > Secrets and variables > Actions* で登録する（手元からは `gh secret set GOOGLE_CHAT_WEBHOOK_URL`）。
- Webhook URL は `key` と `token` を含む。コード・コミットメッセージ・PR 本文・会話に貼らない。再発行したら、使っている全リポジトリの Secret を更新する。
- 導入後は *Run workflow* で手動実行し、スペースに通知が届くことを確かめる（週次の初回を待たない）。

## 注意

- E2E の不具合検知は最大 1 週間遅れる。
- `schedule` はデフォルトブランチの workflow だけが対象。マージ前には動かない。
- 動かさなかった（skipped の）E2E job の表示名は `E2E (${{ matrix.browser }})` のまま展開されない。この名前を required check に指定しない。
- 標準の通知スクリプトを変えるときは `templates/notify-e2e.sh` を直し、`python3 <skill-dir>/scripts/sync_template.py` でテンプレートへ写し、`node --test` を実行する。

## ファイル

- `templates/ci-standard.yml` — 新規リポジトリ用の骨組み
- `templates/notify-e2e.sh` — 標準の通知スクリプト（正準。テンプレートの通知 step と同一に保つ）
- `scripts/validate_ci.py` — 適合判定（R0〜R9）
- `scripts/sync_template.py` — 通知スクリプトをテンプレートへ同期（`--check` で差分検査）
- `scripts/ci-standard.test.mjs` — `node --test` 用のテスト（変異注入・通知の実送信を含む）
- `references/rationale.md` — 標準の根拠
