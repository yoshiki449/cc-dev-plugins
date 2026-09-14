#!/usr/bin/env bash
# 引継書／ブランチ名から Issue 番号を抽出する
# 使い方: extract-issue-number.sh [handover-path]
#   - 引数なし: 最新引継書とカレントブランチ名から推定
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

HANDOVER="${1:-}"
if [ -z "$HANDOVER" ]; then
  HANDOVER=$("$SCRIPT_DIR/latest-handover.sh")
fi

# 1) 引継書のファイル名から
if [ -n "$HANDOVER" ]; then
  N=$(basename "$HANDOVER" | grep -oE 'issue[0-9]+' | grep -oE '[0-9]+' || true)
  if [ -n "$N" ]; then
    echo "$N"
    exit 0
  fi
  # 2) 引継書本文の Issue: #N 行から
  N=$(grep -oE 'Issue: *#[0-9]+' "$HANDOVER" 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)
  if [ -n "$N" ]; then
    echo "$N"
    exit 0
  fi
fi

# 3) カレントブランチ名から
BRANCH=$(git branch --show-current 2>/dev/null || true)
N=$(echo "$BRANCH" | grep -oE 'issue[0-9]+' | grep -oE '[0-9]+' || true)
if [ -n "$N" ]; then
  echo "$N"
  exit 0
fi

exit 0
