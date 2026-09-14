#!/bin/bash
# 保護ファイル編集ブロックフック
# Edit/Write ツール実行前に発火し、保護対象ファイルへの書き込みをブロックする。
# 保護対象は2系統:
#   1. 固定の保護パターン（.env / package-lock.json 等）
#   2. プロジェクトの .agent/loop-denylist.txt（dev-flow denylist、存在する場合のみ）
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# パスが空なら許可
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# .env.example, env.dev, env.dev.worktree 等は許可
BASENAME=$(basename "$FILE_PATH")
if [[ "$BASENAME" == ".env.example" ]] || [[ "$BASENAME" == env.dev* ]]; then
  exit 0
fi

# 固定の保護パターン
PROTECTED=(".env" "package-lock.json" "go.sum" "gcpCred.json")

for pattern in "${PROTECTED[@]}"; do
  if [[ "$BASENAME" == "$pattern" ]]; then
    echo "保護ファイル '$pattern' への編集はブロックされました。手動で編集してください。" >&2
    exit 2
  fi
done

# ── denylist（.agent/loop-denylist.txt）照合 ──
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(echo "$INPUT" | jq -r '.cwd // empty')}"
PROJECT_DIR="${PROJECT_DIR:-$PWD}"
DENYLIST="$PROJECT_DIR/.agent/loop-denylist.txt"

if [ ! -f "$DENYLIST" ]; then
  exit 0
fi

# プロジェクト相対パスを計算（プロジェクト外のファイルはフルパスのまま照合）
REL_PATH="$FILE_PATH"
case "$FILE_PATH" in
  "$PROJECT_DIR"/*) REL_PATH="${FILE_PATH#"$PROJECT_DIR"/}" ;;
esac

# denylist 自体の編集は許可（人間指示での見直しを妨げない。ループ中の自己書き換えは
# プロンプト層で禁止しており、書き換えの diff は必ず人間レビューに載る）
if [[ "$REL_PATH" == ".agent/loop-denylist.txt" ]]; then
  exit 0
fi

while IFS= read -r line || [ -n "$line" ]; do
  # コメント・空行スキップ
  line="${line%%#*}"
  line="$(echo "$line" | tr -d '[:space:]')"
  [ -z "$line" ] && continue

  if [[ "$line" == */* ]]; then
    # パス glob: ** は畳まず生のまま渡す。[[ == ]] の * は / を跨ぐので ** と等価であり、
    # 畳み込みは不要なうえ有害。${line//\*\*/\*} は bash 4.2 以前で置換文字列の
    # バックスラッシュが残り `\*/migrations/\*` になるため、/ を含む全パターンが
    # 一致しなくなりガードが無音で無効化される（macOS 標準の /bin/bash は 3.2）
    if [[ "$REL_PATH" == $line ]] || [[ "/$REL_PATH" == $line ]]; then
      echo "denylist 抵触: '$REL_PATH' は .agent/loop-denylist.txt のパターン '$line' により自動編集禁止です。手動で編集するか、denylist を見直してください。" >&2
      exit 2
    fi
  else
    # basename glob
    if [[ "$BASENAME" == $line ]]; then
      echo "denylist 抵触: '$BASENAME' は .agent/loop-denylist.txt のパターン '$line' により自動編集禁止です。手動で編集するか、denylist を見直してください。" >&2
      exit 2
    fi
  fi
done < "$DENYLIST"

exit 0
