---
allowed-tools: Bash, Read, Edit
description: ローカル ~/.claude/skills/<name>/ にあるスキルを、公開／私有どちらかの marketplace の plugins/<category>/skills/<name>/ へ機械的に移植する。移植先リポジトリの選択・ファイル移動・plugin.json生成 or version bump・marketplace.json更新・ローカル削除を行う。
disable-model-invocation: false
---

引数: `$ARGUMENTS` = `<skill-name> [<plugin-category>]`

## 実行手順

1. 引数から `<skill-name>` を取り出す。**指定なしならエラー終了**して使い方を提示。

2. **移植先の marketplace を決める。** 2本あるので、ここを間違えると社内資産が公開リポジトリへ入る。
   `AskUserQuestion` で必ず確認し、推測で進めない。

   | 選択肢 | 入れるもの |
   |---|---|
   | 公開（`CC_DEV_PLUGINS_DIR`） | 特定の組織・顧客に依存しない開発支援。社名・製品名・業務リポジトリ名・顧客名が本文に出ないもの |
   | 私有（`CC_PLUGINS_DIR`） | 業務固有。社内の固有名・実データ・社内 SaaS のテナントに触れるもの |

   判断に迷ったら**私有側に倒す**。公開は取り消せないが、あとから公開側へ移すのはいつでもできる。

   パスは手順書に書かず、次で解決する。

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/marketplace_dirs.py --key public    # 公開側
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/marketplace_dirs.py --key private   # 私有側
```

   未設定なら exit 2 で止まる。その場合はユーザーに設定を促して中断する。

3. `<plugin-category>` 未指定なら、選んだリポジトリの `plugins/` 配下をリストアップし、
   ユーザーに「どれに入れるか／新規カテゴリを作るか」を `AskUserQuestion` で尋ねる。
   - 新規候補はスキル名から推測して提示する

4. **必ず --dry-run でプレビュー** を先に実行する。`REPO` は 2 で選んだほうのパス。

```bash
REPO="$(python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/marketplace_dirs.py --key <public|private>)"
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/promote.py \
  --cc-plugins "$REPO" \
  --skill <skill-name> --plugin <plugin-category> --dry-run
```

5. プレビュー結果（移植元・**移植先リポジトリ**・移植先 plugin・新規 or 既存）をユーザーに見せて、
   **承認を取る**（`AskUserQuestion` で yes/no）。移植先リポジトリ名を必ず文面に出す。

6. 承認されたら `--dry-run` を外して本実行する。

7. 完了後、必ず以下を実行：
   - `git -C "$REPO" status` を取って変更内容を確認
   - `git -C "$REPO" add . && git -C "$REPO" commit -m "promote: <name> → <category>"` を **ユーザー承認後** に実行
   - **公開側へ移植したときは、コミット前に公開前スキャンを通す**:
     `bash "$REPO"/plugins/git-secret-guard/scripts/publish-scan.sh --paths <移植したファイル>`
   - push するか確認する

8. **絶対に省略しない**：ユーザーに `/reload-plugins` の実行を案内。これを忘れると Claude Code 側に新スキルが反映されない。
   公開側へ push したときは `/plugin marketplace update cc-dev-plugins` も必要（GitHub URL 参照なので、
   push していないと反映されない）。

## 失敗時の挙動

- ローカル `~/.claude/skills/<name>/` が無い: エラー終了、別の名前を提案
- 移植先 `<repo>/plugins/<category>/skills/<name>/` が既存: エラー終了、`--force` 相当の挙動はサポートしない（手動で消すかrename）
- git push が失敗: ローカル commit は残るので、ユーザーに「あとで手動 push してください」と案内

## 注意

- このコマンドは **不可逆操作（ローカル削除＋commit）** を含む。必ず dry-run → 承認 → 本実行の順を守る。
- 1度に複数スキルを連続移植する場合も、1スキルごとに承認を取る。
