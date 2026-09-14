#!/usr/bin/env bash
# 対象Gitリポジトリに Claude Code のクラウドセッション向けの設定一式
# （.claude/settings.json の plugin 宣言＋SessionStart hook、scripts/install_pkgs.sh）を配置し、
# 環境設定ダイアログの「Setup script」欄に貼るテンプレートを提示する。
#
# 使い方: apply_cloud_env_setup.sh [--no-plugins] [対象ディレクトリ（省略時はカレント）]
#
# 冪等性: 既に配置済みの環境で再実行しても安全（install_pkgs.sh は上書きせず警告、
# settings.json の hook・plugin 宣言は重複登録しない）。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# クラウドは ~/.claude/settings.json を持ち込まないので、リポジトリ側に宣言しないと plugin が入らない。
# owner/repo の短縮形は SSH で clone するのが既定なので、HTTPS の git URL で書く。
MARKETPLACE_NAME="cc-dev-plugins"
MARKETPLACE_URL="https://github.com/yoshiki449/cc-dev-plugins.git"
# cc-meta は ~/.cc-plugins/.env が無いと exit 2 で止まるので、クラウドには入れない。
PLUGINS=(dev-flow poc-flow git-secret-guard)

DECLARE_PLUGINS=1
TARGET_DIR=""
for arg in "$@"; do
    case "$arg" in
        --no-plugins) DECLARE_PLUGINS=0 ;;
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
[ -f go.mod ] && HAS_GO=1
{ [ -f docker-compose.yml ] || [ -f compose.yml ]; } && HAS_COMPOSE=1
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
        [ "$HAS_GO" = 1 ] && echo '[ -f go.mod ] && go mod download'
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

# === 3. .claude/settings.json に SessionStart hook と plugin 宣言を冪等にマージ ===
mkdir -p .claude
SETTINGS=".claude/settings.json"
HOOK_COMMAND='"$CLAUDE_PROJECT_DIR"/scripts/install_pkgs.sh'
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

PLUGINS_JSON=$(printf '%s\n' "${PLUGINS[@]}" | jq -R . | jq -s .)
TMP=$(mktemp)
jq --arg cmd "$HOOK_COMMAND" \
   --argjson declare "$DECLARE_PLUGINS" \
   --arg mp "$MARKETPLACE_NAME" \
   --arg url "$MARKETPLACE_URL" \
   --argjson plugins "$PLUGINS_JSON" '
    (if ((.hooks.SessionStart // []) | any(.hooks[]?.command == $cmd)) then .
     else
        .hooks //= {} |
        .hooks.SessionStart //= [] |
        .hooks.SessionStart += [
            { matcher: "startup|resume", hooks: [ { type: "command", command: $cmd } ] }
        ]
     end)
    | if $declare == 1 then
        .extraKnownMarketplaces //= {} |
        .extraKnownMarketplaces[$mp] //= { source: { source: "git", url: $url } } |
        .enabledPlugins //= {} |
        # //= は false も未設定と同じに扱い、ユーザーが止めた plugin を戻してしまう
        reduce $plugins[] as $p (.;
            if (.enabledPlugins | has("\($p)@\($mp)")) then . else .enabledPlugins["\($p)@\($mp)"] = true end)
      else . end
' "$SETTINGS" > "$TMP"

if cmp -s "$TMP" "$SETTINGS"; then
    rm -f "$TMP"
    log "既存: $SETTINGS は設定済みです（変更なし）"
else
    mv "$TMP" "$SETTINGS"
    log "更新: $SETTINGS に SessionStart hook / plugin 宣言をマージ"
fi

# === 4. Setup script テンプレートを表示 ===
log "以下を claude.ai/code の環境設定ダイアログ「Setup script」欄に貼り付けてください:"
echo "----------------------------------------"
cat "$SKILL_DIR/assets/setup-script-template.sh"
echo "----------------------------------------"

RECOMMEND=()
[ "$HAS_PLAYWRIGHT" = 1 ] && RECOMMEND+=("Playwright のブロックを有効化し、環境の Network access を Custom にして配布元を追加してください（@playwright/test を検出）")
[ "$HAS_COMPOSE" = 1 ] && RECOMMEND+=("docker pull のブロックを有効化してください（docker-compose.yml/compose.yml を検出）")
if [ "${#RECOMMEND[@]}" -gt 0 ]; then
    log "このリポジトリ向けの推奨:"
    for r in "${RECOMMEND[@]}"; do
        echo "  - $r" >&2
    done
fi

# === 5. 注意事項の案内 ===
echo ""
cat "$SKILL_DIR/references/cloud-environment-notes.md"
