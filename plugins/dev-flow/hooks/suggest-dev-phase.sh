#!/bin/bash
# dev-flow フェーズ想起フック（行為時点のスキル誘導）
# PreToolUse(Edit|Write|Bash) で発火し、「コードを書こうとする瞬間」「gh issue create の瞬間」
# 「REQUIREMENTS.md / DESIGN.md を書こうとする瞬間」に、該当する dev-flow フェーズスキル
# （dev-implement / dev-fix / dev-plan / auto-spec / auto-design）の起動リマインダーを
# additionalContext として注入する。
# - ブロックしない・permissionDecision に触れない（権限フローを変えない）注入型
# - フェーズマーカー .agent/.dev-flow-active（中身=ブランチ名、各フェーズスキルが開始時に書く）
#   または ship マーカー（.git 実体の下の dev-ship-active）があれば沈黙
# - 同一セッション×同一カテゴリの案内は1回のみ（.agent/.dev-flow-suggest-mute）
# - 強制はしない。成果物欠落の決定的ガードは pre-pr-guard.sh（gh pr create の一点）が担う
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
SID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# 実行ディレクトリの git リポジトリルートを特定（リポ外・.agent/ 無しは対象外）
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
CWD="${CWD:-$PWD}"
REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/.agent" ]; then
  exit 0
fi

# フェーズマーカーが現ブランチと一致していれば dev-flow チェーン内 → 沈黙
BRANCH=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)
# ship マーカーは .git 実体（--git-common-dir）配下にある。worktree と main clone で
# 共有される必要があるため .agent/ には置けない（.agent/ は gitignore なので worktree に
# チェックアウトされない。Issue #36）。ここが旧パスのままだと、ship 済みでも沈黙せず
# フェーズ想起の注入が止まらない。
GIT_COMMON=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)
case "$GIT_COMMON" in
  "") GIT_COMMON="$REPO_ROOT/.git" ;;
  /*) ;;
  *) GIT_COMMON="$REPO_ROOT/$GIT_COMMON" ;;
esac
for m in "$REPO_ROOT/.agent/.dev-flow-active" "$GIT_COMMON/dev-ship-active"; do
  if [ -f "$m" ] && [ -n "$BRANCH" ] && [ "$(tr -d '[:space:]' < "$m")" = "$BRANCH" ]; then
    exit 0
  fi
done

CATEGORY=""
MSG=""
case "$TOOL" in
  Edit|Write)
    FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    [ -z "$FILE" ] && exit 0
    case "$FILE" in */.agent/*) exit 0 ;; esac
    BASE=$(basename "$FILE")
    if [ "$BASE" = "REQUIREMENTS.md" ] || [ "$BASE" = "DESIGN.md" ]; then
      CATEGORY="specdoc"
      MSG="[dev-flow] REQUIREMENTS.md / DESIGN.md への書き込みを検知しました。autopilot フローでは auto-spec（要件定義）/ auto-design（設計）スキルで生成して人間レビュー（TP1/TP2）を通す想定です。該当するなら Skill ツールでの起動を検討してください（該当しなければ無視してよい）。"
    elif echo "$BASE" | grep -qE '\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|cs|vue|svelte|rs|c|cc|cpp|h|hpp)$'; then
      CATEGORY="code"
      MSG="[dev-flow] コードファイルへの書き込みを検知しました。開発タスクの実装・修正であれば、着手前に Skill ツールで dev-implement（新規実装・継続実装）または dev-fix（バグ修正）を起動してください。dev-flow フェーズ実行中や非開発の軽微な編集であれば無視してよい（この案内は同一セッションで1回のみ）。"
    else
      exit 0
    fi
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
    # クォート内（コミットメッセージ等）の誤検知を防ぐ（pre-pr-guard.sh と同じ対策）
    CLEANED=$(printf '%s' "$COMMAND" | sed "s/'[^']*'//g" | sed 's/"[^"]*"//g')
    if echo "$CLEANED" | grep -qE '(^|[;&|[:space:]])gh[[:space:]]+issue[[:space:]]+create'; then
      CATEGORY="issue"
      MSG="[dev-flow] gh issue create を検知しました。開発案件の Issue であれば、要件調査→仕様設計→Issue 作成→フェーズ分割まで行う dev-plan スキル経由での作成を検討してください（該当しなければ無視してよい）。"
    else
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac

# 同一セッション×同一カテゴリは1回のみ
MUTE="$REPO_ROOT/.agent/.dev-flow-suggest-mute"
if grep -qxF "$SID $CATEGORY" "$MUTE" 2>/dev/null; then
  exit 0
fi
echo "$SID $CATEGORY" >> "$MUTE"

jq -n --arg ctx "$MSG" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
exit 0
