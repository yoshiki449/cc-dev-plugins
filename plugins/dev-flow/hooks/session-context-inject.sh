#!/bin/bash
# SessionStart(startup)時のコンテキスト自動注入
# git情報 + 引継書 + DEVELOPMENT.md冒頭を注入する

echo "## セッション開始コンテキスト"
echo ""

# git情報（gitリポジトリの場合のみ）
if git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  echo "### Git状態"
  echo "ブランチ: $(git branch --show-current 2>/dev/null)"
  CHANGES=$(git status --short 2>/dev/null | head -15)
  if [ -n "$CHANGES" ]; then
    echo "変更ファイル:"
    echo "$CHANGES"
    REMAINING=$(git status --short 2>/dev/null | wc -l)
    if [ "$REMAINING" -gt 15 ]; then
      echo "  ... 他 $((REMAINING - 15)) ファイル"
    fi
  else
    echo "変更なし（クリーン）"
  fi
  echo ""
fi

# 引継書（前フェーズからの引継ぎ — 最新ファイルを取得）
if [ -n "$CLAUDE_PROJECT_DIR" ] && [ -d "$CLAUDE_PROJECT_DIR/.agent/handovers" ]; then
  LATEST=$(ls -t "$CLAUDE_PROJECT_DIR/.agent/handovers"/*.md 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    echo "### 引継書（$(basename "$LATEST")）"
    cat "$LATEST"
    echo ""
  fi
fi

# DEVELOPMENT.md冒頭（プロジェクト規約の要約）
if [ -n "$CLAUDE_PROJECT_DIR" ] && [ -f "$CLAUDE_PROJECT_DIR/DEVELOPMENT.md" ]; then
  echo "### 開発規約（DEVELOPMENT.md 冒頭）"
  head -20 "$CLAUDE_PROJECT_DIR/DEVELOPMENT.md"
  echo ""
fi

# 開発フロースキルの案内
echo "### 利用可能なスキル"
echo "/dev, /dev:plan, /dev:setup, /dev:implement, /dev:verify, /dev:ship"
