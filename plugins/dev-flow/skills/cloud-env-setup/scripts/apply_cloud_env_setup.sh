#!/usr/bin/env bash
# 対象Gitリポジトリに Claude Code のクラウドセッション向けの設定一式
# （.claude/settings.json の SessionStart hook、scripts/install_pkgs.sh）を配置し、
# 環境設定ダイアログの「Setup script」欄に貼るテンプレート（plugin の導入を含む）を提示する。
#
# 使い方: apply_cloud_env_setup.sh [対象ディレクトリ（省略時はカレント）]
#
# 冪等性: 既に配置済みの環境で再実行しても安全（install_pkgs.sh は上書きせず警告、
# settings.json の hook は重複登録しない）。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# plugin はリポジトリの settings.json に宣言してもクラウドでは入らず（2026-09 実測）、Setup script で
# 入れた分と二重に出るので、ここでは宣言を書かない。導入は assets/setup-script-template.sh が持つ。
TARGET_DIR=""
for arg in "$@"; do
    case "$arg" in
        # 以前は plugin 宣言を省く指定だった。宣言自体を書かなくなったので、互換のため受け付けて無視する
        --no-plugins) ;;
        *) TARGET_DIR="$arg" ;;
    esac
done
TARGET_DIR="${TARGET_DIR:-$(pwd)}"

log()  { printf '==> %s\n' "$*" >&2; }
warn() { printf '==> [WARN] %s\n' "$*" >&2; }
err()  { printf '==> [ERROR] %s\n' "$*" >&2; }

if [ ! -d "$TARGET_DIR" ]; then
    err "$TARGET_DIR が見つかりません"
    exit 1
fi
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

# worktree では .git がファイルなので -d では判定しない
if [ ! -e "$TARGET_DIR/.git" ]; then
    err "$TARGET_DIR はGitリポジトリのルートではありません（.git が見つかりません）"
    exit 1
fi
command -v jq >/dev/null 2>&1 || { err "jq が必要です"; exit 1; }

cd "$TARGET_DIR"
log "対象リポジトリ: $TARGET_DIR"

# === 1. マニフェスト検出 ===
HAS_NPM=0; HAS_PIP=0; HAS_UV=0; HAS_GO=0; HAS_COMPOSE=0; HAS_PLAYWRIGHT=0
[ -f package.json ] && HAS_NPM=1
[ -f requirements.txt ] && HAS_PIP=1
{ [ -f pyproject.toml ] && [ -f uv.lock ]; } && HAS_UV=1
{ [ -f docker-compose.yml ] || [ -f compose.yml ]; } && HAS_COMPOSE=1
# バックエンドをサブディレクトリに置くモノレポもあるので、go.mod も Playwright と同じく1階層下まで見る。
# 見つけたディレクトリは install_pkgs.sh の生成（§2）で go mod download の cd 先として使う
GO_MOD_DIRS=()
for gm in go.mod */go.mod; do
    if [ -f "$gm" ]; then
        HAS_GO=1
        GO_MOD_DIRS+=("$(dirname "$gm")")
    fi
done
# E2E を frontend/ や e2e/ に分けているリポジトリもあるので1階層下まで見る
for pj in package.json */package.json; do
    if [ -f "$pj" ] && grep -q '"@playwright/test"' "$pj" 2>/dev/null; then
        HAS_PLAYWRIGHT=1
    fi
done
log "検出結果: npm=$HAS_NPM pip=$HAS_PIP uv=$HAS_UV go=$HAS_GO compose=$HAS_COMPOSE playwright=$HAS_PLAYWRIGHT"

# === 2. scripts/install_pkgs.sh を生成 ===
mkdir -p scripts
INSTALL_SCRIPT="scripts/install_pkgs.sh"
if [ -e "$INSTALL_SCRIPT" ]; then
    warn "$INSTALL_SCRIPT は既に存在します。上書きしません（内容を確認して手動マージしてください）"
else
    {
        echo '#!/bin/bash'
        echo '# クラウドセッションでのみ実行するプロジェクト依存インストール。'
        echo '# ローカルでは既に整っている前提のためスキップする。'
        echo '# cloud-env-setup スキルで生成'
        echo 'set -euo pipefail'
        echo ''
        echo '[ "${CLAUDE_CODE_REMOTE:-false}" = "true" ] || exit 0'
        echo 'cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"'
        echo ''
        [ "$HAS_NPM" = 1 ] && echo '[ -f package.json ] && npm install'
        [ "$HAS_PIP" = 1 ] && echo '[ -f requirements.txt ] && pip install -r requirements.txt'
        [ "$HAS_UV" = 1 ] && echo '[ -f pyproject.toml ] && [ -f uv.lock ] && uv sync'
        if [ "$HAS_GO" = 1 ]; then
            for d in "${GO_MOD_DIRS[@]}"; do
                if [ "$d" = "." ]; then
                    echo '[ -f go.mod ] && go mod download'
                else
                    echo "[ -f '$d/go.mod' ] && ( cd '$d' && go mod download )"
                fi
            done
        fi
        echo ''
        echo '# .env の作り方やサービスの起動はリポジトリごとに違うので、ここには持たずに委ねる'
        echo 'if [ -f scripts/cloud-session-init.sh ]; then'
        echo '    bash scripts/cloud-session-init.sh'
        echo 'fi'
        echo ''
        echo 'exit 0'
    } > "$INSTALL_SCRIPT"
    chmod +x "$INSTALL_SCRIPT"
    log "作成: $INSTALL_SCRIPT"
fi

# === 3. .claude/settings.json に SessionStart hook を冪等にマージ ===
mkdir -p .claude
SETTINGS=".claude/settings.json"
HOOK_COMMAND='"$CLAUDE_PROJECT_DIR"/scripts/install_pkgs.sh'
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

TMP=$(mktemp)
jq --arg cmd "$HOOK_COMMAND" '
    if ((.hooks.SessionStart // []) | any(.hooks[]?.command == $cmd)) then .
    else
        .hooks //= {} |
        .hooks.SessionStart //= [] |
        .hooks.SessionStart += [
            { matcher: "startup|resume", hooks: [ { type: "command", command: $cmd } ] }
        ]
    end
' "$SETTINGS" > "$TMP"

if cmp -s "$TMP" "$SETTINGS"; then
    rm -f "$TMP"
    log "既存: $SETTINGS は設定済みです（変更なし）"
else
    mv "$TMP" "$SETTINGS"
    log "更新: $SETTINGS に SessionStart hook をマージ"
fi

# === 4. ~/.cc-plugins/overlay/claude-rules/ の汎用ルールを .claude/rules/ に転記 ===
# 境界: 入力 = overlay 側の1ファイル（中身は関知しない）／出力 = 対象リポジトリの1ファイル／
# 責務は転記のみ。overlay は qc overlay（skills/_shared/reference/qc-overlay.md）と同じ
# 「plugin 外参照は ~/.cc-plugins/.env と ~/.cc-plugins/overlay/ の2つだけ例外」の枠に載るが、
# qc/ 配下の manifest.json 必須という契約とは独立した別サブディレクトリ（claude-rules/）を使う。
# 無くても動く（qc overlay と同じ方針。~/.claude/CLAUDE.md はクラウドに届かないので、
# 汎用ルールの抜粋だけを事前に overlay 側へ書いておいてもらう前提）。
CLAUDE_RULES_SRC="${CC_PLUGINS_CLAUDE_RULES_FILE:-$HOME/.cc-plugins/overlay/claude-rules/cloud-portable-rules.md}"
if [ -f "$CLAUDE_RULES_SRC" ]; then
    mkdir -p .claude/rules
    RULES_DEST=".claude/rules/cloud-portable-rules.md"
    RULES_MARKER_START="<!-- cloud-env-setup:claude-rules START (自動生成。編集は overlay 側 ~/.cc-plugins/overlay/claude-rules/ で行う) -->"
    RULES_MARKER_END="<!-- cloud-env-setup:claude-rules END -->"

    if [ -f "$RULES_DEST" ] && ! grep -qF "$RULES_MARKER_START" "$RULES_DEST"; then
        warn "$RULES_DEST は既に存在しますが管理マーカーが無いため変更しません（手動で確認してください）"
    else
        # マーカーブロックだけを除いた残り（利用者がブロックの前後に書いた記述）を保持し、
        # 末尾に新しいブロックを再構成する。位置までは保持しない（前後どちらにあったかは問わない）。
        RULES_REMAINDER=""
        if [ -f "$RULES_DEST" ]; then
            RULES_REMAINDER="$(awk -v s="$RULES_MARKER_START" -v e="$RULES_MARKER_END" '
                $0 == s { skip=1; next }
                $0 == e { skip=0; next }
                skip { next }
                { print }
            ' "$RULES_DEST")"
        fi
        TMP_RULES=$(mktemp)
        {
            [ -n "$RULES_REMAINDER" ] && printf '%s\n' "$RULES_REMAINDER"
            echo "$RULES_MARKER_START"
            cat "$CLAUDE_RULES_SRC"
            echo ""
            echo "$RULES_MARKER_END"
        } > "$TMP_RULES"

        if [ -f "$RULES_DEST" ] && cmp -s "$TMP_RULES" "$RULES_DEST"; then
            rm -f "$TMP_RULES"
            log "既存: $RULES_DEST は最新です（変更なし）"
        else
            mv "$TMP_RULES" "$RULES_DEST"
            log "更新: $RULES_DEST に汎用ルールを反映"
        fi
    fi

    # .claude/* を許可リスト化した .gitignore（SKILL.md の案内どおりの形）だと、
    # !.claude/rules/ を足し忘れた場合にここだけ黙って ignore される。生成成功の
    # ログだけでは気づけないので、ここで実際に check-ignore して警告する。
    if git check-ignore -q "$RULES_DEST" 2>/dev/null; then
        warn "$RULES_DEST は .gitignore で無視されています。コミットされずクラウドに届きません（.claude/* を除外しているなら !.claude/rules/ も .gitignore に追加してください）"
    fi
else
    log "汎用ルール overlay 無し（$CLAUDE_RULES_SRC）。.claude/rules/ は生成しません"
fi

# === 5. Setup script テンプレートを表示 ===
log "以下を claude.ai/code の環境設定ダイアログ「Setup script」欄に貼り付けてください:"
echo "----------------------------------------"
cat "$SKILL_DIR/assets/setup-script-template.sh"
echo "----------------------------------------"

RECOMMEND=()
[ "$HAS_PLAYWRIGHT" = 1 ] && RECOMMEND+=("Playwright: プリインストールのブラウザと @playwright/test の要求版がずれるので、セッション初期化で npx playwright install を実行してください（@playwright/test を検出）")
[ "$HAS_COMPOSE" = 1 ] && RECOMMEND+=("docker compose: Allowed domains に production.cloudfront.docker.com を足し、docker pull のブロックを有効化してください。ビルドでパッケージを取得するならプロキシ CA を渡す必要があります（注意事項を参照）")
[ "$HAS_GO" = 1 ] && RECOMMEND+=("Go ツールチェーン: VM に Go はプリインストールされていません（npm/pip/uv は Node/Python が VM 側にあるため気づきにくいですが、Go だけは無い）。テンプレートの「Go を使うリポジトリ」ブロックのコメントを外し、go.mod の go ディレクティブに合わせて GOVER を書き換えてください。Allowed domains に go.dev と dl.google.com の両方を足す必要があります（tarball の実体は dl.google.com から配信されるため、go.dev だけでは 403 で失敗します）")
if [ "${#RECOMMEND[@]}" -gt 0 ]; then
    log "このリポジトリ向けの推奨:"
    for r in "${RECOMMEND[@]}"; do
        echo "  - $r" >&2
    done
fi

# === 6. 注意事項の案内 ===
echo ""
cat "$SKILL_DIR/references/cloud-environment-notes.md"
