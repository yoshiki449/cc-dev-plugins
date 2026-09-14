#!/usr/bin/env bash
# 新規引継書のパスを生成する（既存ファイルがあればエラー終了で衝突を防ぐ）
# 使い方: new-handover-path.sh [issue番号]
set -euo pipefail

ISSUE="${1:-}"
TS=$(date +%Y%m%d-%H%M)

if [ -n "$ISSUE" ]; then
  PATH_OUT=".agent/handover-${TS}-issue${ISSUE}.md"
else
  PATH_OUT=".agent/handover-${TS}.md"
fi

mkdir -p .agent

if [ -e "$PATH_OUT" ]; then
  echo "ERROR: handover already exists: $PATH_OUT" >&2
  exit 1
fi

echo "$PATH_OUT"
