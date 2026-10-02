#!/bin/bash
# クラウドで WebSearch / WebFetch を呼ぶ瞬間に、cloud-research スキル（制限のない research 環境へ
# 調査を委譲する）の起動リマインダーを additionalContext として注入する。
# - ブロックしない・permissionDecision に触れない（権限フローを変えない）注入型
# - 絞り込み（クラウドだけ・同一セッションで1回）はこのスクリプトの1箇所だけに置く。hooks.json には条件を書かない
# - research 環境の子セッションでは沈黙する。環境名は hook から分からないので、子セッションの最初の
#   ユーザーメッセージに入る目印で見分ける。ここで沈黙しないと、子が孫を作り続ける
INPUT=$(cat)
[ "${CLAUDE_CODE_REMOTE:-false}" = "true" ] || exit 0

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
case "$TOOL" in
  WebSearch|WebFetch) ;;
  *) exit 0 ;;
esac

# 目印の正準は skills/cloud-research/SKILL.md の cloud-research-child-marker で囲んだ1行。
# 親セッションの transcript にも目印は現れる（create_session の prompt や SKILL.md の Read 結果）ので、
# 「ユーザーメッセージの本文の先頭にある」形（"content":"[...] / "text":"[...]）だけを子の印とする。
MARKER='[cloud-research:child]'
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  if grep -qF -e "\"content\":\"$MARKER" -e "\"text\":\"$MARKER" "$TRANSCRIPT" 2>/dev/null; then
    exit 0
  fi
fi

# 同一セッションで1回のみ（WebSearch と WebFetch は同じカテゴリとして数える）
SID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
MUTE="${TMPDIR:-/tmp}/dev-flow-cloud-research-mute"
if grep -qxF "$SID" "$MUTE" 2>/dev/null; then
  exit 0
fi
echo "$SID" >> "$MUTE"

MSG="[dev-flow] クラウドで $TOOL を検知しました。この環境は Allowed domains を絞っているため、WebSearch の結果は取れても WebFetch / curl でページ本文を読めないことがあります（EGRESS_BLOCKED）。ドメイン制限のない research 環境へ調査を任せる cloud-research スキルがあります。ページ本文まで読む調査・最新仕様や公式ドキュメントの確認なら、調べ始める前に Skill ツールで cloud-research を起動してください。見出しと URL だけで足りる検索や、自分が research 環境の子セッションである場合は無視してよい（この案内は同一セッションで1回のみ）。"

jq -n --arg ctx "$MSG" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
