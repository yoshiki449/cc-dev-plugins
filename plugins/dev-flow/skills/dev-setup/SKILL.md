---
name: dev-setup
description: 準備フェーズ。企画完了後・実装前の環境セットアップに加えて、**ローカル環境の起動／立て直し／シードデータ補修／Docker化／ホストからのアクセス疎通** などの **環境系トラブルシュート** も担当する。ブランチ作成→Docker基盤スキャフォールド→環境構築→動作確認を行う。ユーザーが「ローカル環境を立ち上げて」「シードデータがおかしい」「ローカル環境に○○データが入っていない」「Docker化してホストから繋ぎたい」「環境を作り直したい」「ブランチを切って」「○○のセットアップをして」と言ったら起動する。**副作用が大きいため、原則ユーザーの明示指示で実行する**。
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, gh
---

# /dev-setup - 準備フェーズ

## リファレンス

- **引継書テンプレート**: [../_shared/reference/handover-template.md](../_shared/reference/handover-template.md)（B6 で読み込む）

## 手順

### B0. 引継書の読み込み
1. `bash skills/_shared/scripts/latest-handover.sh` で最新引継書のパスを取得し、存在すれば読み込む
2. Issue URL、フェーズ分割内容、ユーザー指示を確認
3. 引継書に `## アーキテクチャ設計` セクションが含まれていれば **新規プロジェクト** と判定し、B1a を実行する

### B1a. Docker基盤スキャフォールド（新規プロジェクトのみ）

B0 で新規プロジェクトと判定した場合に実施。引継書の `## アーキテクチャ設計` セクションを読み、以下のファイルを生成する。

1. **docker-compose.yml** の生成
   - 引継書のサービス構成テーブルを元に全サービスを定義
   - 全サービスを `app-network`（bridge）に接続
   - `nginx` サービスのみ `${NGINX_PORT}:80` でホスト公開
   - 各サービスに `healthcheck` を設定
   - DB等ステートフルなサービスに `volumes` を設定

2. **nginx/nginx.conf** の生成
   - 引継書のnginxルーティングテーブルを元に `location` ブロックを設定
   - `/api/` → バックエンドサービス
   - `/` → フロントエンドサービス

3. **.env.example** の生成
   - 引継書の環境変数テーブルを元に変数名とコメントを記載
   - 秘匿値は空欄またはプレースホルダーにする
   - `.env.example` をコミット対象、`.env` を `.gitignore` に追加

4. **.env の初期作成**
   - `.env.example` をコピーして `.env` を作成
   - `NGINX_PORT` はデフォルト `8080` を設定

5. ユーザーに生成ファイルの一覧を提示し、確認を求める

### B1. ブランチ作成＋worktree 準備 ⚠ 必須（スキップ不可）

> **原則**: 実装・修正は必ず **worktree の中** で行う。main clone（`repo/`）では作業しない。フラット構成のリポは自動で `repo/` に移行してから worktree を切り出す。過去に main 誤コミット事故が発生しているため（memory `bash-cwd-drift-in-worktree`）。

#### B1-0. 現在の構造を確認
```bash
bash skills/_shared/scripts/ensure-worktree.sh
```
出力の `status` で分岐する:

| status | 意味 | 次にやること |
|---|---|---|
| `ok` | 既に worktree 内・規約準拠 | B2 に進む（worktree はそのまま使う）|
| `on_main_branch` + repo_basename が `repo` | 規約準拠だが main clone 上（ベースブランチ=main/master/develop 等。判定は `origin/HEAD` を優先し、無ければ main/master/develop を見る） | B1-2 の worktree 作成に進む |
| `on_main_branch` + フラット | フラット repo のベースブランチ上 | B1-1 の自動移行を実施 |
| `non_worktree_path` | worktree だがパスが規約外 | 動作するので B2 に進む（次回セットアップ時に規約準拠パスに揃える）|
| `flat_repo` | フラット repo の非ベースブランチ | ユーザーに確認: 「(a) 現在のブランチをそのまま worktree 化 (b) ベースブランチに戻してから B1-1 移行 → 新ブランチ作成」|

**移行不能ケース**（B1-1 の事前チェックで判明する。該当したら**移行を実行せず**ユーザーに確認する）:

| 検出内容 | 意味 | 次にやること |
|---|---|---|
| repo 直下に `repo` / `worktrees` という名前のエントリが既存 | 名前衝突 | ユーザーに確認: 「(a) 既存を別名にリネームして移行 (b) 移行を諦めてフラットのまま進める」|
| `git worktree list` が2行以上（既に worktree がある） | 旧 worktree あり | 既存 worktree の `.git` は旧パスを**絶対パス**で指すため移行で壊れる。先に `git worktree remove` するかユーザーに確認 |

#### B1-1. フラット repo → 規約構造への自動移行（`on_main_branch` + フラットのときのみ）

> **方式**: **repo ディレクトリの「中だけ」を操作する**。親ディレクトリもマウントポイント名も一切触らないので、必要な権限は repo ディレクトリ自身への書き込みだけで済む。

前提（1つでも引っかかったら**移行せず**ユーザーに確認）:
- 未コミット変更があれば **必ず先にコミット or stash** する（`git status` で確認）
- 並行して別セッションが同 repo で作業中でないことをユーザーに確認する
- **既存の worktree が無いこと**（`git worktree list` が main clone 1 行だけ）
- **repo 直下に `repo` / `worktrees` という名前のエントリが無いこと**
- Docker を使うプロジェクトでは、**先に compose プロジェクト名を控えてから**コンテナを停止する（ファイルを掴んだままの移動を避ける）

手順（`<project-folder>` は `git rev-parse --show-toplevel` の結果）:
```bash
# 1. 未コミット・未 stash が無いことを確認
git -C <project-folder> status --porcelain
# 空でなければ中断してユーザーに確認

# 1b. 事前チェック（いずれかが引っかかったら中断）
git -C <project-folder> worktree list              # main clone の 1 行だけであること
ls -a <project-folder> | grep -Ex 'repo|worktrees' # 何も出ないこと

# 1c. Docker 利用時: プロジェクト名を控えてから停止（B3 で使う）
docker compose ls          # ← NAME 列を記録。down 後は docker inspect でも取れなくなる
docker compose down        # -v は付けない（volume を消さない）

# 2. repo ディレクトリの「中だけ」を操作して規約構造にする
cd <project-folder>
mkdir repo worktrees
# エントリを先に全列挙してから移動する（走査中のディレクトリを書き換えない）
mapfile -d '' ENTRIES < <(find . -maxdepth 1 -mindepth 1 ! -name repo ! -name worktrees -print0)
mv -t repo -- "${ENTRIES[@]}"

# 3. 動作確認
ls -a <project-folder>                                       # repo と worktrees の 2 つだけ
find <project-folder>/repo -maxdepth 1 -mindepth 1 | wc -l   # 移行前のエントリ数と一致
git -C <project-folder>/repo status
git -C <project-folder>/repo remote -v
```

- **glob（`mv * repo/`）は使わない**。`.git` / `.env` / `.gitignore` / `.agent` / `.claude` などのドットファイルを取りこぼす。`.git` を置き去りにすると「動くように見えて壊れている」状態になる
- `mapfile -d` は bash 4.4+、`mv -t` は GNU coreutils 前提（Linux / WSL2 では問題なし）

> **注意**: この移行はユーザーのシェル履歴・IDE 設定・他 Claude セッションの cwd に影響する。実行前に必ずユーザーに **「今このリポで並行作業中の他ターミナル・IDE・Claude セッションがないか」** を確認する。
>
> **なぜ `mv <repo> <repo>.tmp` 方式を使わないか**: ディレクトリ名は**親ディレクトリ内のエントリ**なので、リネームには**親の書き込み権限**が要る。コンテナ内 Claude では repo が bind マウントポイントで、その親はコンテナ側が作った root 所有の土台ディレクトリのため、`mv` も `mkdir` も `Permission denied` になる。さらに**マウントポイントの rename は権限があっても `EBUSY` で失敗する**。上記の「内側だけ操作する」方式ならどちらの制約も踏まない。

#### B1-2. worktree 作成
```bash
cd <project-folder>/repo

# ベースブランチの最新を fetch
git fetch origin

# feature ブランチを作成しつつ worktree として切り出す
BRANCH="feature/<名前>"
WORKTREE_NAME=$(echo "$BRANCH" | sed 's|/|-|g')
git worktree add ../worktrees/${WORKTREE_NAME} -b "$BRANCH" origin/<ベースブランチ>

# 以降の作業ディレクトリ
cd ../worktrees/${WORKTREE_NAME}
pwd  # ← <project-folder>/worktrees/<branch-basename> であることを目視確認
git branch --show-current  # ← feature/<名前> であることを目視確認
```

**以降 B2〜B6 のコマンドは必ずこの worktree 内で実行する**。引継書には worktree の絶対パスを記録する。

#### B1-3. gitignore 対象を main clone から worktree へコピー ⚠ 必須

worktree には **git 管理下のファイルしか来ない**。`.env` / `uploads/` / `.agent/` などの gitignore 対象は空のままなので、放置すると「アプリは起動しているのにデータが空」という紛らわしい状態になる。

```bash
cd <project-folder>/repo
# コピー対象を洗い出す（ignore されていて、かつ実体があるもの）
git status --porcelain --ignored | grep '^!!'

# コピー例（コピー先に同名ディレクトリが既にある場合は必ず src/. 形式を使う）
cp -a .env                <project-folder>/worktrees/<branch-basename>/.env
cp -a uploads/.           <project-folder>/worktrees/<branch-basename>/uploads/
cp -a .agent/.            <project-folder>/worktrees/<branch-basename>/.agent/
```

- `cp -a src dst` は **dst が既存ディレクトリだと入れ子になる**（`dst/src/` ができる）。tracked な `.gitkeep` などで既にディレクトリが存在するケースがあるので、ディレクトリは `cp -a src/. dst/` 形式で写す
- `node_modules` は写さない（B2 で判断する）
- **B3 の `COMPOSE_PROJECT_NAME` 追記より前に実施する**。順序を逆にすると `.env` を上書きして設定が消える

#### B1-3.5. 判定較正テンプレートの適用（`size-tier.conf`）

`.agent/size-tier.conf`（`assess-change-size.sh` が読むプロジェクト固有の較正）は
**`.agent/` が全面 gitignore のため worktree には来ない**。Issue ごとに worktree を切る運用では、
較正が最も効くべき場所で毎回既定値に戻る。

```bash
cd <project-folder>/worktrees/<branch-basename>
# tracked なテンプレートがあり、かつ conf がまだ無いときだけコピーする
if [ -f docs/testing/size-tier.conf.template ] && [ ! -e .agent/size-tier.conf ]; then
  mkdir -p .agent && cp docs/testing/size-tier.conf.template .agent/size-tier.conf
  echo "適用: docs/testing/size-tier.conf.template → .agent/size-tier.conf"
fi
```

- **B1-3 の後に実行する。** B1-3 で main clone から `.agent/` を写している場合、そこに既に
  conf があればそちらが正しい（プロジェクトで育てた較正）。**テンプレートで上書きしない**
- テンプレートが無いリポジトリでは **no-op**（大半のリポはこれ）
- テンプレートは `docs/` 配下（tracked）に置く。`.agent/` に置くと同じ理由で消える

> このステップを飛ばしても、`assess-change-size.sh` が
> 「テンプレートがあるのに conf が有効でない」を検出して `warnings` に出す。
> 逆に言えば、**判定器側の警告は既に切ってある worktree と dev-setup 非経由の運用に対する
> 唯一の防御**なので、警告が出たら握りつぶさずここに戻ってくること。

#### B1-3.6. 較正テンプレートの生成（`docs/testing/size-tier.conf.template` が無いリポジトリ）

B1-3.5 は `docs/testing/size-tier.conf.template` を**コピーするだけ**で、テンプレート自体を
作る手順は無い。このリポジトリが初めて `dev-setup` を通るとき、テンプレートを対話で作る。

- **発火条件**: `docs/testing/size-tier.conf.template` が**存在しないリポジトリ**のときだけ。
  既にあるなら B1-3.5 がそのままコピーするので、このステップは **no-op**
- **⚠ B1-3.5 の優先順位を壊さないこと**: B1-3 で main clone から `.agent/` を写した結果
  `.agent/size-tier.conf` が既に存在する場合、それは**プロジェクトで育てた較正**なので、
  ここで生成したテンプレートで**上書きしない**。`docs/` 配下への書き出しはこの条件と無関係に行う
- **生成しない選択肢を残す**: 既定閾値（100/500）・既定パターンで妥当なリポジトリでは
  生成しないのが正しい。`AskUserQuestion` で「テンプレートを生成する / 生成しない（既定値のまま
  で妥当）」をユーザーに確認してから進める

> ⚠ **「生成しない」を選ぶと、以後この較正が効いていないことを知らせる音はどこからも鳴らない。**
> 判定器の較正警告は `docs/testing/size-tier.conf.template` が**存在するときだけ**発火するため、
> テンプレートを作らなければ警告経路自体が無い。つまり「既定値で妥当と判断した」と
> 「**誰も較正を検討していない**」が出力上まったく区別できなくなる。**判断と理由は B6 の
> 引継書に必ず記録すること**

生成する場合の対話手順:

1. **行数分布を実データで確認する**。既定閾値（100/500）で L 比率が高すぎないかを、
   閾値を提案する前に見る。
   ```bash
   # 直近マージ済み PR の変更行数（+/-）を一覧
   gh pr list --state merged --limit 50 --json number,additions,deletions \
     --jq '.[] | .additions + .deletions'
   # gh が使えない/PR運用でない場合は commit 単位で代用
   git log --numstat --pretty=format:'--%h--' | awk '/^--/{if(s)print s;s=0;next}{s+=$1+$2}END{print s}'
   ```
   分布を見て、既定値のままで妥当なら `threshold_m=` / `threshold_l=` の行は**書かない**
   （書かない = 既定値を使う。閾値を上げるのは常に「緩和方向」の警告付きなので、必要な分だけ書く）
2. **テストディレクトリの実構成を確認し、`exclude:` を提案する**。
   `find . -type d \( -name tests -o -name test -o -name __tests__ -o -name e2e \)`
   などでテストの置き場所を実測してから、`exclude:` の行を組み立てる。
   **テストを除外する理由**: 除外しないと「テストを厚く書くほどレビューが重くなる」逆
   インセンティブが働く。実測（ある業務リポジトリの PR）では 4,754 行のうち 3,741 行（79%）が
   テストコードで、判定を左右していたのは実質テストの量だった
3. **記法は `skills/_shared/reference/size-tier-conf.md` を参照する**（`=` は値設定、`:` は
   パターン追加、`_reset` はフラグ、`/` の有無で照合対象が変わる、行末コメント非対応、など。
   ここで書き間違えると `load_conf()` が行番号だけを warnings に出して黙って無視する）
4. **`docs/testing/size-tier.conf.template` に書き出す**（`docs/` 配下＝tracked。`.agent/` に
   置くと B1-3.5 と同じ理由で worktree ごとに消える。ディレクトリが無ければ先に
   `mkdir -p docs/testing` する）
   - **生成したら `git add docs/testing/size-tier.conf.template` して単独コミットする**（untracked のままだと worktree を消したときに一緒に消え、「tracked で残す」という目的が達成されない）
   - **`.agent/size-tier.conf` が既にあるなら、その内容を出発点にする**（新規に書き起こすと tracked テンプレートと実際の較正が乖離し、以後の全 worktree に乖離した方が配られる）
5. **`.agent/size-tier.conf` が無いときだけ同じ内容をコピーする**（B1-3.5 と同じ操作。
   テンプレートを `docs/` に作っただけでは、当の worktree で較正がまだ効いていない）
   ```bash
   cd <worktreeの絶対パス>
   if [ ! -e .agent/size-tier.conf ]; then
     mkdir -p .agent && cp docs/testing/size-tier.conf.template .agent/size-tier.conf
     echo "適用: docs/testing/size-tier.conf.template → .agent/size-tier.conf"
   fi
   ```
6. **判定器を実際に走らせて、警告が消えたことを確認する**（書いただけで効いていない状態を
   放置しない）
   ```bash
   bash skills/_shared/scripts/assess-change-size.sh --dir <worktreeの絶対パス>
   ```
   出力 JSON の `warnings` に `docs/testing/size-tier.conf.template` を含む行が無ければ較正は
   効いている（`--dir` は cwd 依存にしない。B1-1〜E1.2 系の全消費箇所と同じ理由で、cwd が
   ずれると判定サイズが無音で軽い方へ落ちる）
   - **`既定を緩めている` の警告は出てよい**（exclude の追加・閾値の引き上げは緩和方向なので必ず鳴る仕様）。ここで見るのは `docs/testing/size-tier.conf.template` を含む警告が消えたことだけ
   - **`解釈できなかった` を含む警告が1件でもあれば、書式を直してから再実行する**（警告は20件で打ち切られるため、解釈不能行が多いと較正警告そのものが省略されて偽の緑になる）
   - setup 時点では差分がまだ無いので `lines:0` が正常。ここで見るのは `warnings` だけ

<!-- このフェンスの info string は conf 固定（テストが節から実例を抜き出して判定器に食わせる） -->
以下は対話で埋めた結果の完成形（プレースホルダではなく実際に効く値。数値・パターンは
リポジトリごとにヒアリング内容で変わる）。**この実例の数値をそのままコピーしないこと。**
業務リポジトリの較正が下敷きで、閾値は step 1 の実測で必ず置き換える:

```conf
exclude: **/tests/**
exclude: **/test/**
exclude: **/__tests__/**
exclude: **/e2e/**
exclude: *.test.*
exclude: *.spec.*

threshold_m=150
threshold_l=1200
```

### B2. 環境構築（worktree 内で実施）
1. DEVELOPMENT.md の手順に従い開発環境を構築
2. **テストの実行場所を判定する**（依存インストールの要否がここで決まる）
   - `docker-compose.yml` の `volumes` を見て、テストコード（`e2e/` / `__tests__/` 等）がコンテナにマウントされているか確認する
   - **コンテナ内で完結する** → ホスト側の `npm ci` は不要
   - **ホスト側で実行する**（テストディレクトリがマウントされていない・Playwright をホストで動かす等）→ worktree で `npm ci` が必要。リポジトリによっては 1GB 近くになるので、所要時間と容量をユーザーに伝えてから実行する
3. 依存パッケージのインストール（2 の判定に従う）
4. 環境ファイルの準備（.env等。B1-3 でコピー済みなら内容を確認するだけ）

### B3. Docker起動（Docker利用の場合）

1. **`COMPOSE_PROJECT_NAME` を固定する** ⚠ 必須（worktree 運用では必須）
   - compose のプロジェクト名は **compose ファイルのあるディレクトリ名から導出される**。worktree で何もせず起動すると `feature-xxx_db_data` のような**空 volume が新規作成され、ローカル DB を失ったように見える**
   - B1-1 の `docker compose ls` で控えた名前（＝移行前の repo ディレクトリ名）を使う
   - worktree の `.env` に `COMPOSE_PROJECT_NAME=<元のプロジェクト名>` を追記する（または起動時に毎回 `-p <元のプロジェクト名>` を付ける。`.env` 方式のほうが付け忘れが起きない）
   - 控え忘れた場合、稼働中なら `docker compose ls`、停止後なら「移行前の repo ディレクトリ名」が既定値
2. `docker compose up -d --build`
3. 各サービスの起動確認（ログ確認）
4. **volume が再利用されているか確認する**: `docker volume ls | grep <元のプロジェクト名>` で既存 volume が使われていること、アプリ上で既存データが見えることを確認する

### B4. DB初期化（DB利用の場合）
1. マイグレーション実行
2. テストデータ・テストユーザー作成（DEVELOPMENT.md参照）

### B5. 動作確認
1. バックエンドヘルスチェック
2. フロントエンドアクセス確認

### B5.5. Playwright reporter 設定（E2E を含むプロジェクトのみ）

E2E テストを含むプロジェクト（`playwright.config.{ts,js,mjs,cjs}` が存在する）では、必ず JSON reporter を有効化する。これは [[dev-videos]] スキルが `test-results/results.json` を読んで動画 → 完全な日本語テストタイトルへのマッピングを取得するため。

1. プロジェクトルートに `playwright.config.*` が存在するか確認
2. 存在すれば [[enable-pw-reporter]] スキルを Skill ツールで起動して reporter を設定
   - 内部的には `node <enable-pw-reporter-skill-dir>/scripts/enable.js --dir <project-root> --dry-run` で差分確認 → ユーザー承認後に `--dry-run` を外し **`--verify` を付けて**本実行
   - 既に必要な設定が揃っているプロジェクトはスキップされる（idempotent）
   - reporter 配列に裸の文字列要素がある壊れた config（過去バージョンが生成したもの。Playwright が読めず E2E が起動不能）は**修復される**。reason に `reporter:repair` が出たらその旨をユーザーに伝える
3. `test-results/` と `playwright-report/` が `.gitignore` に入っているか確認、無ければ追加（`results.json` などをコミットしないため）
4. **`npx playwright test --list` が通ることを確認する**（`--verify` を付けていればスクリプトが実施済み）
   - 書き換えが成功しても config が Playwright に読めるとは限らない。ここを飛ばすと「E2E が丸ごと起動不能なのに setup は完走した」状態になる
5. 一度テストを実行して `test-results/results.json` が実際に生成されることを確認（任意・余裕があれば）

> 既存プロジェクト全体を一括 migrate する場合は `--all` モードを使う（[[enable-pw-reporter]] の SKILL.md を参照）。

### B6. 引継書更新 ⚠ 必須（スキップ不可）

> **注意**: このステップはsetupフェーズの最終ステップであり、**ユーザーとのやり取りが途中で入っても必ず実行すること**。

0. **B1-1 で移行した場合のみ**: project folder に `.agent` の symlink を張る

   移行後、project folder 自体は git リポジトリではなくなる。ハーネスの cwd はそこのままなので、次フェーズの `latest-handover.sh`（**cwd 相対の `.agent/` を見る**）が引継書を見つけられない。

   ```bash
   ln -sfn <project-folder>/worktrees/<branch-basename>/.agent <project-folder>/.agent
   ```

   - `-sfn` を必ず付ける。`-n` が無いと、既存の symlink（ディレクトリ指し）の**中**に入れ子で作られる
   - 向き先はブランチごとに変わる。次に dev-setup を実行したときは**新しい worktree に貼り替える**（同じコマンドでよい）
   - **正準の `.agent/` は worktree 側**。`repo/.agent` は B1-3 でコピーした別実体で、同期はされない。以降のフェーズは worktree の中で作業するのでこれで整合する

1. `bash skills/_shared/scripts/new-handover-path.sh <Issue番号>` で新規引継書パスを発番
2. [../_shared/reference/handover-template.md](../_shared/reference/handover-template.md) の骨格 + setup 固有セクションを書き出す:
   - **worktree 絶対パス**（`<project-folder>/worktrees/<branch-basename>/`）← 実装フェーズが確認する
   - **main clone 絶対パス**（`<project-folder>/repo/`）
   - 環境情報（コンテナ名、外部公開ポート、内部ネットワーク名、**`COMPOSE_PROJECT_NAME`**）
   - **テストの実行場所**（コンテナ内で完結 / ホスト側で `npm ci` 済み）← B2 の判定結果
   - テストユーザー情報（メール／パスワード／ロール）
   - DB マイグレーション・シード実行の有無
   - 各サービスの URL
   - 次フェーズ（implement）への引継事項
3. ユーザーに「/clear して次フェーズ（/dev-implement）に進めますか？」と確認

## 出力
- `.agent/handover-YYYYMMDD-HHMM-issue<番号>.md`（引継書・新規作成、worktree 絶対パス必須）
- worktree ディレクトリ（`<project-folder>/worktrees/<branch-basename>/`）
- 各サービスの URL を画面表示

## worktree 規約（この skill が守る不変条件）

```
<project-folder>/
├── .agent -> worktrees/<branch-basename>/.agent   ← symlink（B6-0。cwd が project-folder のままでも引継書が引ける）
├── repo/                          ← main clone、リモート同期・非作業
└── worktrees/
    └── <branch-basename>/         ← 実装・修正はここで行う。.agent の正準はこちら
```

- `<branch-basename>` は `feature/foo` → `feature-foo` のように `/` を `-` に置換する
- フラット構成（`<project-folder>` 直下に `.git` がある）を検出したら B1-1 で自動移行する
- 移行は **repo ディレクトリの中だけを操作する**（親ディレクトリを触らない）。コンテナ内 Claude では repo が bind マウントポイントで親が root 所有のため、親を触る方式は必ず失敗する
- `dev-implement` / `dev-fix` は Step 0.5 でこの規約への準拠を再チェックし、逸脱していれば中断する
