#!/bin/bash
# post-commit-update.sh
# git commit 成功後に .claude/ 配下のドキュメント更新を促すフック
#
# PostToolUse(Bash) で呼び出され、コマンドが git commit を含む場合に
# systemMessage を返してClaudeにドキュメント更新を指示する

INPUT=$(cat)

# Bashコマンドの内容を取得
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# git commit コマンドかどうかを判定
if echo "$COMMAND" | grep -qE 'git\b.*\bcommit\b'; then
  # 終了コードを確認（成功したコミットのみ対象）
  EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_result.exitCode // 0')
  if [ "$EXIT_CODE" = "0" ]; then
    COMMIT_HASH=$(git log -1 --format="%h" 2>/dev/null || echo "unknown")
    COMMIT_MSG=$(git log -1 --format="%s" 2>/dev/null || echo "unknown")

    # 日報チェック: 本日分が未記入なら追記リマインド
    WORKLOG_DIR="$HOME/.agent/worklog"
    WORKLOG_FILE="$WORKLOG_DIR/$(date +%Y-%m).md"
    TODAY=$(date +%m-%d)
    WORKLOG_MSG=""

    if [ ! -f "$WORKLOG_FILE" ] || ! grep -q "| $TODAY |" "$WORKLOG_FILE"; then
      WORKLOG_MSG="\n\n■ 日報未記入です。セッション終了前に以下を更新してください：\n  ~/.agent/worklog/$(date +%Y-%m).md\n  形式: | $TODAY | プロジェクト名 | 作業内容（1-2行） |"
    fi

    cat <<EOF
{
  "systemMessage": "【ドキュメント更新リマインド】\nコミット完了（${COMMIT_HASH}）。以下を更新してください：\n1. history.md - コミット履歴に追記（必須）\n2. knowledge.md - 新しい知見があれば追記\n3. architecture.md - API/DB変更があれば更新\n4. context.md - 新しい制約・定数があれば更新\n5. preferences.md - ユーザーから指摘があれば追記\n※ 変更がないファイルはスキップ\n\n■ knowledge.md更新時の追加確認：\n  今回得た知見に他プロジェクトでも使える汎用的なものがあれば\n  ~/.claude/knowledge/ の該当カテゴリにも追記してください。${WORKLOG_MSG}"
}
EOF
    exit 0
  fi
fi

# git commit 以外のコマンドは何もしない
exit 0
