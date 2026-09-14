#!/usr/bin/env bash
# 対象Gitリポジトリに Claude Code on the web（クラウドセッション）向けの
# SessionStart hook 一式（.claude/settings.json + scripts/install_pkgs.sh）を配置し、
# 環境設定ダイアログの「Setup script」欄に貼るテンプレートを提示する。
#
# 使い方: apply_cloud_env_setup.sh [対象ディレクトリ（省略時はカレント）]
#
# 冪等性: 既に配置済みの環境で再実行しても安全（install_pkgs.sh は上書きせず警告、
# settings.json の hook は重複登録しない）。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-$(pwd)}"

log()  { printf '==> %s\n' "$*" >&2; }
warn() { printf '==> [WARN] %s\n' "$*" >&2; }
err()  { printf '==> [ERROR] %s\n' "$*" >&2; }

if [ ! -d "$TARGET_DIR" ]; then
    err "$TARGET_DIR が見つかりません"
    exit 1
fi
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

if [ ! -d "$TARGET_DIR/.git" ]; then
    err "$TARGET_DIR はGitリポジトリではありません（.git が見つかりません）"
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
if [ -f package.json ] && grep -q '"@playwright/test"' package.json 2>/dev/null; then
    HAS_PLAYWRIGHT=1
fi
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
        echo ''
        [ "$HAS_NPM" = 1 ] && echo '[ -f package.json ] && npm install'
        [ "$HAS_PIP" = 1 ] && echo '[ -f requirements.txt ] && pip install -r requirements.txt'
        [ "$HAS_UV" = 1 ] && echo '[ -f pyproject.toml ] && [ -f uv.lock ] && uv sync'
        [ "$HAS_GO" = 1 ] && echo '[ -f go.mod ] && go mod download'
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

if [ ! -f "$SETTINGS" ]; then
    jq -n --arg cmd "$HOOK_COMMAND" '{
        hooks: {
            SessionStart: [
                { matcher: "startup|resume", hooks: [ { type: "command", command: $cmd } ] }
            ]
        }
    }' > "$SETTINGS"
    log "作成: $SETTINGS"
else
    if jq -e --arg cmd "$HOOK_COMMAND" '
        (.hooks.SessionStart // []) | any(.hooks[]?.command == $cmd)
    ' "$SETTINGS" >/dev/null 2>&1; then
        log "既存: $SETTINGS には既に登録済みです（変更なし）"
    else
        TMP=$(mktemp)
        jq --arg cmd "$HOOK_COMMAND" '
            .hooks //= {} |
            .hooks.SessionStart //= [] |
            .hooks.SessionStart += [
                { matcher: "startup|resume", hooks: [ { type: "command", command: $cmd } ] }
            ]
        ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
        log "更新: $SETTINGS にSessionStart hookを追加"
    fi
fi

# === 4. Setup script テンプレートを表示 ===
log "以下を claude.ai/code の環境設定ダイアログ「Setup script」欄に貼り付けてください:"
echo "----------------------------------------"
cat "$SKILL_DIR/assets/setup-script-template.sh"
echo "----------------------------------------"

RECOMMEND=()
[ "$HAS_PLAYWRIGHT" = 1 ] && RECOMMEND+=("Playwright/Chrome + 日本語フォントのブロックを有効化してください（package.jsonに@playwright/testを検出）")
[ "$HAS_COMPOSE" = 1 ] && RECOMMEND+=("docker compose pull/build のブロックを有効化してください（docker-compose.yml/compose.ymlを検出）")
if [ "${#RECOMMEND[@]}" -gt 0 ]; then
    log "このリポジトリ向けの推奨:"
    for r in "${RECOMMEND[@]}"; do
        echo "  - $r" >&2
    done
fi

# === 5. 注意事項の案内 ===
echo ""
cat "$SKILL_DIR/references/cloud-environment-notes.md"
