---
name: dev-videos
description: dev-hub の互換エイリアス。E2E 録画の閲覧は /dev-hub を使う。
user-invocable: true
disable-model-invocation: true
---

# /dev-videos — dev-hub への互換エイリアス

動画ビューアの全機能は dev-hub（開発成果物ハブ）にある。dev-hub は設計ドキュメント（docs/）・採用プラン（docs/plans/）・explain-diff 理解ドキュメント（.agent/explanations/）も同じ UI で閲覧できる。

モデルからは自動起動しない。動画を見たいという依頼で dev-hub と同時に発火すると、この案内ページを経由して1往復を失うため。`/dev-videos` と打たれたときだけ下記を実行する。

## 操作フロー（Claude 用）

1. dev-hub のサーバを起動する:

```bash
node <dev-hub-skill-dir>/scripts/server.js
```

（`Bash` の `run_in_background: true` で実行し、`http://localhost:7777` を案内する）

2. 環境変数・UI・セキュリティ等の詳細は `dev-hub/SKILL.md` を参照
3. 停止は background job の `kill`
