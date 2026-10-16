#!/usr/bin/env bash
# /clear の後に貼る再開プロンプトを組み立てる
# 使い方: resume-prompt.sh <次フェーズのスキル名> [引継書パス]
#   1行目: /<スキル名> 引継書: <絶対パス>   ← 次フェーズはこのパスを探索せずに読む
#   2行目: 作業場所: <絶対パス>（ブランチ・Issue 番号）
# 終了コード: 0=出力あり / 1=引継書が無い・読めない / 2=スキル名が不正
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SKILL="${1:-}"
SKILL="${SKILL#/}"
# 出力はそのままチャットに貼られ、スラッシュコマンドとして実行される。空白や ; を含む名前は通さない
if ! [[ $SKILL =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: 次フェーズのスキル名が不正: '${1:-}'（例: dev-verify）" >&2
  exit 2
fi

EXPLICIT="${2:-}"
if [ -n "$EXPLICIT" ]; then
  if [ ! -r "$EXPLICIT" ]; then
    echo "ERROR: 引継書を読めない: $EXPLICIT" >&2
    exit 1
  fi
  HANDOVER="$EXPLICIT"
else
  # 探し方は latest-handover.sh に一本化する（ls | tail -1 は日付なしの引継書を最新と誤る）
  HANDOVER=$("$SCRIPT_DIR/latest-handover.sh")
  if [ -z "$HANDOVER" ]; then
    echo "ERROR: 引継書が見つからない（cwd: $(pwd -P) の .agent/handover-*.md）" >&2
    exit 1
  fi
fi

HANDOVER_ABS="$(cd "$(dirname "$HANDOVER")" && pwd -P)/$(basename "$HANDOVER")"

# 作業場所は引継書の「worktree 絶対パス」欄を優先する。cwd は /clear 後の起動場所に左右されるため。
# 欄が未記入のテンプレート（<project-folder> のような山括弧入り）は採用しない
WT=$(grep -m1 'worktree 絶対パス' "$HANDOVER" 2>/dev/null | sed -n 's/.*`\([^`]*\)`.*/\1/p' || true)
if [ -z "$WT" ] || [[ $WT == *"<"* ]]; then
  WT=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
fi

ISSUE=$("$SCRIPT_DIR/extract-issue-number.sh" "$HANDOVER" 2>/dev/null || true)
BRANCH=$(git -C "$WT" branch --show-current 2>/dev/null || true)

DETAIL=""
[ -n "$BRANCH" ] && DETAIL="ブランチ: $BRANCH"
if [ -n "$ISSUE" ]; then
  DETAIL="${DETAIL:+$DETAIL、}Issue: #$ISSUE"
fi

echo "/$SKILL 引継書: $HANDOVER_ABS"
if [ -n "$DETAIL" ]; then
  echo "作業場所: $WT（$DETAIL）"
else
  echo "作業場所: $WT"
fi
