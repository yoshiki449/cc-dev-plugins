#!/usr/bin/env bash
# 用途: ループ運用ファイル（.agent/LOOP.md / .agent/STATE.md / .agent/loop-denylist.txt）を
#       テンプレートから生成する。既存ファイルには触れない（idempotent）。
# 使い方: bash ensure-loop-files.sh [プロジェクトルート]
#   引数省略時は git rev-parse --show-toplevel、それも失敗したら $PWD。
# 出力: 新規作成したファイルのパスを1行ずつ標準出力（既存のみなら出力なし）。exit 0。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/../../../templates"

PROJECT_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"
AGENT_DIR="$PROJECT_ROOT/.agent"
mkdir -p "$AGENT_DIR"

ensure() {
  local template="$1" target="$2"
  if [ ! -f "$target" ]; then
    if [ ! -f "$template" ]; then
      echo "ERROR: テンプレートが見つかりません: $template" >&2
      exit 1
    fi
    cp "$template" "$target"
    echo "$target"
  fi
}

ensure "$TEMPLATES_DIR/LOOP-template.md" "$AGENT_DIR/LOOP.md"
ensure "$TEMPLATES_DIR/STATE-template.md" "$AGENT_DIR/STATE.md"
ensure "$TEMPLATES_DIR/loop-denylist-template.txt" "$AGENT_DIR/loop-denylist.txt"
