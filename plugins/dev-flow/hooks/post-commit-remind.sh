#!/bin/bash
# git commit 成功後のリマインドフック
# PostToolUse(Bash) で発火し、コミット成功時にリマインドを出力する
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# git commit コマンドの場合のみ
echo "$COMMAND" | grep -qE '^git commit' || exit 0

# tool_result がない場合（PostToolUse以外）はスキップ
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_result.exit_code // empty' 2>/dev/null)
if [ "$EXIT_CODE" != "0" ] && [ -n "$EXIT_CODE" ]; then
  exit 0
fi

REMINDERS=""

# history.md 更新リマインド
if [ -n "$CLAUDE_PROJECT_DIR" ] && [ -f "$CLAUDE_PROJECT_DIR/.agent/history.md" ]; then
  REMINDERS=".agent/history.md にコミット履歴を追記してください。"
fi

# 新規ファイルのテスト存在チェック
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  STAGED=$(cd "$CLAUDE_PROJECT_DIR" && git diff --name-only HEAD~1 HEAD 2>/dev/null || true)
  MISSING=""
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    # .go ファイル（_test.go 以外）
    if [[ "$file" == *.go ]] && [[ "$file" != *_test.go ]]; then
      TEST="${file%.go}_test.go"
      [ ! -f "$CLAUDE_PROJECT_DIR/$TEST" ] && MISSING="$MISSING  $file\n"
    fi
  done <<< "$STAGED"

  if [ -n "$MISSING" ]; then
    REMINDERS="$REMINDERS\nテストファイルが見つからない変更:\n$MISSING"
  fi
fi

[ -n "$REMINDERS" ] && echo -e "$REMINDERS"
exit 0
