---
allowed-tools: Bash
description: ローカル ~/.claude/skills/<name>/ に .cc-plugins-keep マーカーを置き、cc-plugins への移植対象から除外する。「このスキルはローカルで使うだけ、cc-plugins には移さない」と判定したときに使う。
disable-model-invocation: false
---

引数: `$ARGUMENTS` = `<skill-name>` （または `<skill-name> --unset` でマーカー解除）

## 実行手順

1. 引数から `<skill-name>` を取り出す。指定なしならエラー終了。
2. `--unset` フラグの有無を確認。

3. マーカー設置（通常）:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/mark_keep.py \
  --skill <skill-name>
```

4. マーカー解除（`--unset` 指定時）:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/mark_keep.py \
  --skill <skill-name> --unset
```

5. 完了後、ユーザーに以下を伝える：
   - 設置の場合: 「`<skill-name>` を `/promote-check` の対象から除外しました。以降ローカル運用継続。」
   - 解除の場合: 「`<skill-name>` を再び `/promote-check` の対象に戻しました。」

## 注意

- このコマンドは ローカル `~/.claude/skills/<name>/` 配下に空の `.cc-plugins-keep` ファイルを置くだけで、副作用は最小。
- marketplace のパスは使わない。マーカーはローカル側にしか書かないので、移植先の選択とは無関係。
- ローカル削除や cc-plugins 側への変更は **一切しない**（移植したい場合は `/promote-skill` を使う）。
