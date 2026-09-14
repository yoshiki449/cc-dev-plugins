#!/bin/bash
# プロジェクト用 post-commit-update.sh
# git commit 成功後に .agent/ 配下のドキュメント更新をリマインドする
# 配置先: <project>/.agent/hooks/post-commit-update.sh

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qE 'git\b.*\bcommit\b'; then
  EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_result.exitCode // 0')
  if [ "$EXIT_CODE" = "0" ]; then
    COMMIT_HASH=$(git log -1 --format="%h" 2>/dev/null || echo "unknown")
    cat <<EOF
{
  "systemMessage": "【ドキュメント更新リマインド】\nコミット完了（${COMMIT_HASH}）。以下を更新してください：\n1. .agent/history.md - コミット履歴に追記（必須）\n2. .agent/knowledge.md - 新しい知見があれば追記"
}
EOF
    exit 0
  fi
fi

exit 0
