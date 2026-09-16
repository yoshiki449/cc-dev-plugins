#!/usr/bin/env bash
# クラウドセッションで、各リポジトリの使い捨てスタックを立てて動作確認とテストができる状態にする。
# リポジトリ固有の設定は <repo>/.claude/cloud-stack.json に置き、ここは manifest 駆動の共通処理だけを持つ。
#
# 使い方:
#   cloud-stack.sh list                  見つかったリポジトリ
#   cloud-stack.sh prepare               全リポジトリの軽い準備（SessionStart hook から呼ぶ）
#   cloud-stack.sh up <repo> [--wait]    スタックを立てる（既定はバックグラウンド）
#   cloud-stack.sh status [repo]         各処理の状態
#   cloud-stack.sh down <repo>           スタックを止める
#   cloud-stack.sh test <repo> [name]    manifest の tests を実行する
#
# リポジトリの見つけ方: CLOUD_STACK_ROOT（既定は CLAUDE_PROJECT_DIR、無ければ作業ディレクトリ）が
# git リポジトリならそれ1つ、そうでなければ直下の git リポジトリ。複数リポジトリのセッションでは
# 作業ディレクトリが各リポジトリの親になり、リポジトリ側の hook と .mcp.json は効かない（2026-09 実測）。
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="${CLOUD_STACK_ROOT:-${CLAUDE_PROJECT_DIR:-$PWD}}"
STATE_BASE="${CLOUD_STACK_STATE:-$HOME/.cloud-stack}"
# クラウドの VM はプロキシの自己署名 CA 越しに外へ出る。この CA を渡さないと、ビルドコンテナ内の
# pip / npm / apk / go が証明書エラーで落ちる（2026-09 実測。公的 CA ＋プロキシ CA のバンドル）
CA_BUNDLE="${CLOUD_CA_BUNDLE:-/root/.ccr/ca-bundle.crt}"
CA_IN_CONTEXT=.cloud-stack-ca.crt
MANIFEST_REL=.claude/cloud-stack.json

die() { echo "cloud-stack: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq が必要"

repos() {
    if [ -e "$ROOT/.git" ]; then
        [ -f "$ROOT/$MANIFEST_REL" ] && echo "$ROOT"
        return 0
    fi
    local d
    for d in "$ROOT"/*/; do
        d=${d%/}
        [ -e "$d/.git" ] && [ -f "$d/$MANIFEST_REL" ] && echo "$d"
    done
    return 0
}

repo_dir() {
    local name=$1 d
    while IFS= read -r d; do
        [ "$(basename "$d")" = "$name" ] && { echo "$d"; return 0; }
    done < <(repos)
    die "リポジトリが見つからない（.claude/cloud-stack.json を持つもの）: $name"
}

mf() { jq -r "$2" "$1/$MANIFEST_REL"; }
state_dir() { echo "$STATE_BASE/$(basename "$1")"; }

# 処理ごとにロックを取り、完了は成功時に書く目印だけで判定する。
# resume でも SessionStart hook は走るので、ロックが無いと同じ処理が並走する。npm ci は開始直後に
# node_modules を消して作り直すため、並走すると互いに壊し、途中で失敗しても「入れ済み」に見える
run_task() {
    local state=$1 name=$2
    shift 2
    mkdir -p "$state"
    exec 9> "$state/$name.lock"
    flock -n 9 || return 0
    # ロック待ちの間に先行の同じ処理が完了していることがある
    [ -e "$state/$name.done" ] && return 0
    rm -f "$state/$name.failed"
    if "$@" >> "$state/$name.log" 2>&1; then
        touch "$state/$name.done"
    else
        touch "$state/$name.failed"
    fi
}

start_bg() {
    local repo=$1 name=$2
    nohup bash "$SELF" --task "$repo" "$name" >/dev/null 2>&1 &
}

# ---- 各処理の本体（--task から呼ばれる） ----

task_npm() {
    local repo=$1 dir=$2
    npm ci --prefix "$repo/$dir"
}

# プリインストールのブラウザは、リポジトリの @playwright/test が要求する版と一致しない
task_playwright() {
    local repo=$1 dir=$2 state
    state=$(state_dir "$repo")
    # 依存の導入は npm 処理と同じロックと目印で済ませる。npm ci は node_modules を先に作ってから中身を
    # 書くので、ディレクトリの有無で判断すると、並走中の npm ci の途中で npx が走り package.json を見失う
    exec 8> "$state/npm-$dir.lock"
    flock 8
    if [ ! -e "$state/npm-$dir.done" ]; then
        npm ci --prefix "$repo/$dir" || return 1
        touch "$state/npm-$dir.done"
        rm -f "$state/npm-$dir.failed"
    fi
    exec 8>&-
    (cd "$repo/$dir" && npx playwright install chromium chromium-headless-shell)
}

inject_ca() {
    awk '
        { print }
        /^[Ff][Rr][Oo][Mm][ \t]/ {
            print "COPY '"$CA_IN_CONTEXT"' /etc/ccr-ca-bundle.crt"
            print "ENV PIP_CERT=/etc/ccr-ca-bundle.crt \\"
            print "    REQUESTS_CA_BUNDLE=/etc/ccr-ca-bundle.crt \\"
            print "    SSL_CERT_FILE=/etc/ccr-ca-bundle.crt \\"
            print "    NODE_EXTRA_CA_CERTS=/etc/ccr-ca-bundle.crt \\"
            print "    GIT_SSL_CAINFO=/etc/ccr-ca-bundle.crt"
        }
    ' "$1"
}

# 本番用の Dockerfile は変えず、各 FROM の直後に CA を入れたクラウド用を状態ディレクトリに生成し、
# 上書き compose で差し替える。同じ Dockerfile を使う全サービスを差し替えないと、漏れたサービスだけ
# ビルドで落ちる。生成イメージはこの VM の中だけで使い捨てにするので、実行時のステージに CA が残るのは許容する
prepare_ca_build() {
    local repo=$1 state=$2 override=$state/docker-compose.cloud.yml n i
    rm -f "$override"
    [ -f "$CA_BUNDLE" ] || return 0
    n=$(mf "$repo" '(.compose.ca_builds // []) | length')
    [ "$n" -gt 0 ] || return 0
    echo "services:" > "$override"
    for i in $(seq 0 $((n - 1))); do
        local df ctx gen ctx_abs ca_abs
        df=$(mf "$repo" ".compose.ca_builds[$i].dockerfile")
        ctx=$(mf "$repo" ".compose.ca_builds[$i].context // \".\"")
        gen="$state/Dockerfile.cloud.$i"
        # context は兄弟リポジトリ（../other）のこともある。相対のまま組み立てると、置いた先と
        # 違うリポジトリの除外に登録してしまうので、先に正規化した絶対パスにする
        ctx_abs=$(cd "$repo/$ctx" && pwd) || return 1
        ca_abs="$ctx_abs/$CA_IN_CONTEXT"
        CA_COPIES+=("$ca_abs")
        cp "$CA_BUNDLE" "$ca_abs" || return 1
        exclude_locally "$ca_abs"
        inject_ca "$repo/$df" > "$gen"
        local svc
        while IFS= read -r svc; do
            {
                echo "  $svc:"
                echo "    build:"
                echo "      context: $ctx_abs"
                echo "      dockerfile: $gen"
            } >> "$override"
        done < <(mf "$repo" ".compose.ca_builds[$i].services[]")
    done
}

# ビルドの間だけ置く CA を、消し損ねてもコミットしないよう除外に足す。context が兄弟リポジトリの
# こともあるので、呼び出し元のリポジトリではなく、CA を実際に置いたリポジトリの除外に足す
exclude_locally() {
    local abs=$1 owner rel exclude
    owner=$(cd "$(dirname "$abs")" && git rev-parse --show-toplevel 2>/dev/null) || return 0
    rel=${abs#"$owner"/}
    exclude="$(git -C "$owner" rev-parse --git-path info/exclude)"
    case "$exclude" in /*) ;; *) exclude="$owner/$exclude" ;; esac
    mkdir -p "$(dirname "$exclude")"
    grep -qxF "/$rel" "$exclude" 2>/dev/null || echo "/$rel" >> "$exclude"
}

compose_args() {
    local repo=$1 state=$2 f envfile
    COMPOSE=(docker compose --project-directory "$repo")
    # `environment: - VAR`（値なし）形式のサービスは、シェルの環境変数か --env-file からしか
    # 値が入らない。run_commands の子シェルで export しても、ここは別プロセスなので届かない
    envfile=$(mf "$repo" '.compose.env_file // empty')
    [ -n "$envfile" ] && [ -f "$repo/$envfile" ] && COMPOSE+=(--env-file "$repo/$envfile")
    while IFS= read -r f; do
        COMPOSE+=(-f "$repo/$f")
    done < <(mf "$repo" '(.compose.files // [])[]')
    [ -f "$state/docker-compose.cloud.yml" ] && COMPOSE+=(-f "$state/docker-compose.cloud.yml")
    return 0
}

ensure_dockerd() {
    docker info >/dev/null 2>&1 && return 0
    # 9>&- は必須。run_task のロックの fd を dockerd が引き継ぐと、dockerd が生きている間
    # ロックが解放されず、以後の up が黙って抜ける
    (dockerd 9>&- >> "$STATE_BASE/dockerd.log" 2>&1 &)
    local _
    for _ in $(seq 1 30); do
        docker info >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

run_commands() {
    local repo=$1 query=$2 cmd
    while IFS= read -r cmd; do
        [ -n "$cmd" ] || continue
        # 標準入力を閉じる。閉じないと、コマンドがこのループの読み込み元を食べて後続の行が飛ぶ
        (cd "$repo" && bash -c "$cmd" < /dev/null) || return 1
    done < <(mf "$repo" "($query // [])[]")
    return 0
}

wait_health() {
    local repo=$1 url svc attempts interval _
    url=$(mf "$repo" '.health.url // empty')
    [ -n "$url" ] || return 0
    svc=$(mf "$repo" '.health.restart_service // empty')
    attempts=${CLOUD_STACK_HEALTH_ATTEMPTS:-$(mf "$repo" '.health.attempts // 60')}
    interval=${CLOUD_STACK_HEALTH_INTERVAL:-$(mf "$repo" '.health.interval // 10')}
    for _ in $(seq 1 "$attempts"); do
        curl -skf -o /dev/null --max-time 5 "$url" && { echo "health ok: $url"; return 0; }
        # 起こし直しにも同じ上書きを付けないと、イメージが無いときに CA の無い元の Dockerfile でビルドする
        [ -n "$svc" ] && { "${COMPOSE[@]}" up -d "$svc" >/dev/null 2>&1 || true; }
        sleep "$interval"
    done
    echo "health ng: $url"
    [ -n "$svc" ] && "${COMPOSE[@]}" logs "$svc" 2>&1 | tail -50
    return 1
}

task_stack() {
    local repo=$1 state=$2 rc=0
    CA_COPIES=()
    # ロックを取った後で張る。前で張ると、ロックに負けてすぐ抜ける2本目が1本目のビルド中の CA を消す。
    # bash は TERM で終わるときも EXIT の trap を実行する。KILL は防げない
    trap 'rm -f "${CA_COPIES[@]}"' EXIT
    ensure_dockerd || { echo "dockerd が起動しない"; return 1; }
    run_commands "$repo" '.compose.pre_up' || return 1
    prepare_ca_build "$repo" "$state" || return 1
    compose_args "$repo" "$state"
    "${COMPOSE[@]}" up --build -d || rc=$?
    rm -f "${CA_COPIES[@]}"
    [ "$rc" -eq 0 ] || return 1
    wait_health "$repo" || return 1
    run_commands "$repo" '.compose.post_up'
}

task_prepare() {
    local repo=$1
    run_commands "$repo" '.prepare'
}

if [ "${1:-}" = "--task" ]; then
    repo=$2
    name=$3
    state=$(state_dir "$repo")
    case "$name" in
        prepare) run_task "$state" prepare task_prepare "$repo" ;;
        stack) run_task "$state" stack task_stack "$repo" "$state" ;;
        npm:*) run_task "$state" "npm-${name#npm:}" task_npm "$repo" "${name#npm:}" ;;
        playwright:*) run_task "$state" "playwright-${name#playwright:}" task_playwright "$repo" "${name#playwright:}" ;;
        *) die "不明な処理: $name" ;;
    esac
    exit 0
fi

stack_running() {
    local repo=$1 state=$2 svc
    [ -e "$state/stack.done" ] || return 1
    svc=$(mf "$repo" '.health.restart_service // empty')
    [ -n "$svc" ] || return 0
    compose_args "$repo" "$state"
    "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "$svc"
}

report_failed() {
    local state=$1 f names=""
    for f in "$state"/*.failed; do
        [ -e "$f" ] || continue
        f=${f##*/}
        names="$names ${f%.failed}"
    done
    echo "$names"
}

cmd=${1:-}
case "$cmd" in
    list)
        repos | while IFS= read -r d; do basename "$d"; done
        ;;
    prepare)
        found=0
        while IFS= read -r repo; do
            found=1
            name=$(basename "$repo")
            state=$(state_dir "$repo")
            mkdir -p "$state"
            failed=$(report_failed "$state")
            [ -n "$failed" ] && echo "cloud-stack: $name: 前回失敗した処理をやり直す:$failed（ログ: $state/<処理名>.log）"
            # 準備は短い同期処理（使い捨て .env の生成など）。後続の依存導入より先に終わらせる
            bash "$SELF" --task "$repo" prepare
            started=""
            while IFS= read -r dir; do
                [ -e "$state/npm-$dir.done" ] || { start_bg "$repo" "npm:$dir"; started="$started npm-$dir"; }
            done < <(mf "$repo" '(.npm // [])[]')
            while IFS= read -r dir; do
                [ -e "$state/playwright-$dir.done" ] || { start_bg "$repo" "playwright:$dir"; started="$started playwright-$dir"; }
            done < <(mf "$repo" '(.playwright // [])[]')
            echo "cloud-stack: $name（$repo）: 準備を開始:${started:- なし（完了済み）}。スタックは \`bash $SELF up $name --wait\`（状態: \`bash $SELF status $name\`）"
        done < <(repos)
        [ "$found" = 1 ] || echo "cloud-stack: .claude/cloud-stack.json を持つリポジトリが無い（$ROOT）"
        ;;
    up)
        [ -n "${2:-}" ] || die "リポジトリ名を指定する"
        repo=$(repo_dir "$2")
        state=$(state_dir "$repo")
        mkdir -p "$state"
        if stack_running "$repo" "$state"; then
            echo "cloud-stack: $2: 起動済み"
            exit 0
        fi
        rm -f "$state/stack.done"
        if [ "${3:-}" = "--wait" ]; then
            bash "$SELF" --task "$repo" stack
            [ -e "$state/stack.done" ] || { echo "cloud-stack: $2: 失敗（ログ: $state/stack.log）"; tail -40 "$state/stack.log"; exit 1; }
            echo "cloud-stack: $2: 起動した"
        else
            start_bg "$repo" stack
            echo "cloud-stack: $2: バックグラウンドで起動を開始（\`cloud-stack status $2\`、ログ: $state/stack.log）"
        fi
        ;;
    status)
        while IFS= read -r repo; do
            name=$(basename "$repo")
            [ -n "${2:-}" ] && [ "$2" != "$name" ] && continue
            state=$(state_dir "$repo")
            line=""
            for f in "$state"/*.log; do
                [ -e "$f" ] || continue
                t=${f##*/}
                t=${t%.log}
                if [ -e "$state/$t.done" ]; then s=done
                elif [ -e "$state/$t.failed" ]; then s=failed
                else s=running; fi
                line="$line $t=$s"
            done
            echo "$name:${line:- まだ何も実行していない}"
        done < <(repos)
        ;;
    down)
        [ -n "${2:-}" ] || die "リポジトリ名を指定する"
        repo=$(repo_dir "$2")
        state=$(state_dir "$repo")
        compose_args "$repo" "$state"
        "${COMPOSE[@]}" down
        rm -f "$state/stack.done"
        ;;
    test)
        [ -n "${2:-}" ] || die "リポジトリ名を指定する"
        repo=$(repo_dir "$2")
        if [ -n "${3:-}" ]; then
            t=$(mf "$repo" ".tests[\"$3\"] // empty")
            [ -n "$t" ] || die "tests に無い: $3（ある名前: $(mf "$repo" '(.tests // {}) | keys | join(", ")')）"
            (cd "$repo" && bash -c "$t")
        else
            rc=0
            while IFS= read -r t; do
                echo "== $t"
                (cd "$repo" && bash -c "$(mf "$repo" ".tests[\"$t\"]")" < /dev/null) || rc=1
            done < <(mf "$repo" '(.tests // {}) | keys[]')
            exit "$rc"
        fi
        ;;
    *)
        sed -n '5,12p' "$SELF" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
