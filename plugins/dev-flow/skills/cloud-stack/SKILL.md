---
name: cloud-stack
description: Claude Code のクラウドセッション（claude.ai/code）で、リポジトリの使い捨てスタック（docker compose）を立てて動作確認・テスト・E2E ができる状態にするスキル。各リポジトリの .claude/cloud-stack.json を読み、プロキシの自己署名 CA を入れたクラウド用ビルドで起動し、health を待ち、テストを実行する。複数リポジトリを付けたセッションでも使える。ユーザーが「クラウドでスタックを立てて」「クラウドで動作確認したい」「クラウドセッションで E2E を回して」「cloud-stack up」「クラウドでテストを回して」と言ったとき、またクラウドセッション（CLAUDE_CODE_REMOTE=true）で dev-verify や dev-qa などがアプリの起動を必要としたときに使う。リポジトリに cloud-stack.json を用意する作業も含む。ローカルの Docker 環境構築（dev-setup）とは別物。
---

# cloud-stack

クラウドセッションの VM で、リポジトリの使い捨てスタックを立てる。仕組みは dev-flow が持ち、リポジトリには固有の設定（`.claude/cloud-stack.json`）だけを置く。

## なぜ plugin が持つのか

複数のリポジトリを付けたクラウドセッションでは、作業ディレクトリが各リポジトリの親になり、**リポジトリに置いた SessionStart hook と `.mcp.json` は効かない**（2026-09 実測）。ユーザー単位で入れた plugin は効くので、仕組みは dev-flow の hook とこのスキルに置く。MCP は共通の環境の Setup script でユーザー単位に登録する（cloud-env-setup のテンプレート）。

## 動き

| いつ | 何をする |
|---|---|
| セッション開始（dev-flow の SessionStart hook、クラウドのときだけ） | `prepare`: 各リポジトリの準備コマンド（使い捨て `.env` の生成など）を同期で実行し、`npm ci` と E2E 用ブラウザの導入をバックグラウンドで始める。スタックは立てない |
| 必要なとき（このスキル） | `up <repo>`: dockerd を起こし、pre_up、CA 入りのクラウド用ビルドで `docker compose up --build -d`、health を待ち、post_up |

各処理は `~/.cloud-stack/<repo>/<処理名>.{log,done,failed}` に状態が残る。resume で hook が再び走っても、ロックで並走させず、完了は成功時の目印だけで判定する。失敗した処理は次の `prepare` で知らせてやり直す。

## 使い方

```bash
S=<skill-dir>/scripts/cloud-stack.sh
bash $S list                    # 対象のリポジトリ
bash $S status [repo]           # 各処理の状態（done / failed / running）
bash $S up <repo> --wait        # 立てて health まで待つ（ビルドを含め数分かかる。待たないなら --wait を外す）
bash $S test <repo> [name]      # manifest の tests を実行
bash $S down <repo>
```

- `up` の前に `status` で `npm-*` / `playwright-*` が done になっているか見る（E2E を回すなら必要）
- 失敗したら `~/.cloud-stack/<repo>/<処理名>.log` の末尾を読んでから次の手を決める
- クラウドで MCP が使えるかは、`claude mcp list` の表示ではなく、ツールを実際に呼んで確かめる

## `.claude/cloud-stack.json` の書式

```json
{
  "prepare": ["bash scripts/make-disposable-env.sh"],
  "npm": ["frontend"],
  "playwright": ["e2e"],
  "compose": {
    "files": ["docker-compose.yml", "docker-compose.ci.yml"],
    "ca_builds": [
      { "dockerfile": "Dockerfile.backend", "context": ".", "services": ["backend", "scheduler"] },
      { "dockerfile": "frontend/Dockerfile", "context": "frontend", "services": ["frontend"] }
    ],
    "pre_up": [],
    "post_up": []
  },
  "health": { "url": "http://localhost:8088/api/health", "restart_service": "backend", "attempts": 60, "interval": 10 },
  "tests": {
    "backend": "docker compose -f docker-compose.yml -f docker-compose.ci.yml exec -T backend pytest -q",
    "frontend": "npm test --prefix frontend"
  }
}
```

| キー | 意味 |
|---|---|
| `prepare` | セッション開始時に同期で実行するコマンド（リポジトリのルートで実行）。秘密は置かず、使い捨て値で `.env` などを作る。短く保つ |
| `npm` | `npm ci` するディレクトリ |
| `playwright` | `@playwright/test` の版のブラウザを入れるディレクトリ（node_modules が無ければ先に `npm ci`） |
| `compose.files` | `docker compose -f` に渡すファイル（リポジトリからの相対。兄弟リポジトリの `../other/compose.yml` も可） |
| `compose.ca_builds` | CA を入れてビルドする Dockerfile と、そのビルドコンテキストと、**その Dockerfile でビルドする全サービス**。漏れたサービスだけ証明書エラーで落ちる |
| `compose.pre_up` / `post_up` | ビルドの前後に実行するコマンド（外部ネットワークの作成、DB の初期化など） |
| `health` | 起動を待つ URL と、応答が無いときに起こし直すサービス |
| `tests` | 名前とコマンド。クラウド用の上書き compose は付かないので、`exec` するだけのコマンドにする |

### 書くときの注意

- **本番用の Dockerfile と compose は変えない。** CA 入りの Dockerfile は `~/.cloud-stack/<repo>/` に生成され、上書き compose で差し替わる。ビルドの間だけ各コンテキストに `.cloud-stack-ca.crt` を置き、終わったら消す（そのクローンの `.git/info/exclude` にも足す）
- CA が無い環境（ローカル）では、上書きを付けずに元の Dockerfile で起動する
- ホストのポートは、同じセッションの他のリポジトリと VM にプリインストールされたサービスと衝突しない値にする
- `prepare` から重い処理（イメージのビルド、全依存の取得）を呼ばない。セッション開始を待たせる

## ファイル構成

- `scripts/cloud-stack.sh` — manifest 駆動の本体（bash ＋ jq）
- `scripts/cloud-stack.test.mjs` — `node --test` 用のテスト（docker などはスタブ）
- `../../hooks/cloud-session-start.sh` — SessionStart hook（クラウドのときだけ `prepare`）
