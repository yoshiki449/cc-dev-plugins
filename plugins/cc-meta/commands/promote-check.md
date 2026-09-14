---
allowed-tools: Bash, Read
description: ローカル ~/.claude/skills/ と cc-plugins を突き合わせて、cc-plugins への移植判断が未決のスキルを一覧表示する。skill-creator で新規スキルを作った直後や、定期的なメンテで使う。
disable-model-invocation: false
---

`cc-plugins` marketplace に対する **未判定スキル** の一覧を出します。

## 実行手順

1. marketplace のパスを解決する。**手順書に絶対パスを書かない。**

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/marketplace_dirs.py
```

`~/.cc-plugins/.env` の `CC_DEV_PLUGINS_DIR`（公開側）と `CC_PLUGINS_DIR`（私有側）を出す。
未設定なら exit 2 で止まり、追記すべき行を教えてくれる。その場合はユーザーに設定を促して中断する。

2. **両方の marketplace を渡して**実行する。片方だけだと、もう片方へ移植済みのスキルが
   「未判定」として出続ける。

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/list_unpromoted.py \
  --cc-plugins "$(python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/marketplace_dirs.py --key public)" \
  --cc-plugins "$(python3 ${CLAUDE_PLUGIN_ROOT}/skills/cc-plugins-promote/scripts/marketplace_dirs.py --key private)"
```

引数 `$ARGUMENTS` にパスが渡されていれば、それを追加の `--cc-plugins` として足す。

3. 出力された未判定スキルがあれば、その**最初の1件**について判断軸4軸（A. 複数環境で使うか、B. 機能の安定度、C. 業務固有度、D. 配布したい先がある）を提示し、「移植する／ローカル保持する／スキップ」をユーザーに尋ねる。
4. ユーザーの判断に応じて：
   - **移植する** → `/promote-skill <name>` の手順に従う（移植先の marketplace と plugin カテゴリを確認）
   - **ローカル保持** → `/mark-keep <name>` の手順に従う
   - **スキップ** → 次のスキルへ
5. 未判定が空（`✓ 未判定スキルはありません。`）の場合は、その旨を伝えて終了。

## 注意

- 未判定が多い（10件超）場合は、最初の数件だけ提示してユーザーに「全部処理する？」を確認すること。一気に進めない。
- 外部 symlink 由来（`gws-*` 等）はスクリプト側で除外済みなので、出てきたものは原則「ユーザーが自分で作った／ローカルにコピーした」スキル。
