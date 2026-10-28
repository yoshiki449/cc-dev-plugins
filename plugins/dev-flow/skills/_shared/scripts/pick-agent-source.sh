#!/usr/bin/env bash
# pick-agent-source.sh
#
# dev-setup B1-3 が `.agent/` のコピー元を選ぶための判定器。
# main clone と既存の worktree を並べて、`.agent/` の最終更新日時とファイル数を比較し、
# 最も新しいものをコピー元に選ぶ。「main clone が正本」とは決め打ちしない
# （worktree を連鎖させる運用では、直前の worktree の `.agent/` のほうが新しく、
#  引継書や評価レポートもそちらにしか無い）。
#
# 使い方: pick-agent-source.sh <dir> [<dir> ...]
#   <dir>: リポジトリまたは worktree のルート。`<dir>/.agent` が無い候補は読み飛ばす。
#   候補の列挙例:
#     git -C <project-folder>/repo worktree list --porcelain | sed -n 's/^worktree //p'
#     （新しく作った worktree 自身は `.agent` が空なので渡してもよいが、選ばれたら除外する）
#
# 出力（stdout、タブ区切り）:
#   candidate <dir> <files> <newest_epoch> <newest_iso>
#   chosen    <dir> <理由>
#   理由は「最終更新が新しい」。最終更新が同秒ならファイル数が多いほう、それも同数なら引数の先頭側。
#
# 終了コード: 0 = 選べた / 2 = 引数なし / 3 = どの候補にも空でない `.agent/` が無い

if [ "$#" -eq 0 ]; then
  echo "使い方: pick-agent-source.sh <dir> [<dir> ...]" >&2
  exit 2
fi

# GNU stat と BSD stat のどちらでも epoch 秒を取る
if stat -c %Y / >/dev/null 2>&1; then
  STAT_FMT=(-c %Y)
else
  STAT_FMT=(-f %m)
fi

best_dir=""
best_mtime=-1
best_files=-1

for dir in "$@"; do
  agent="$dir/.agent"
  [ -d "$agent" ] || continue
  # 末尾 / で symlink の向き先まで辿る（B6-0 は project folder に `.agent` の symlink を張る）
  files="$(find "$agent/" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$files" -gt 0 ] || continue
  mtime="$(find "$agent/" -type f -exec stat "${STAT_FMT[@]}" {} + 2>/dev/null | sort -n | tail -1)"
  [ -n "$mtime" ] || continue
  if date -u -d "@$mtime" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    iso="$(date -u -d "@$mtime" +%Y-%m-%dT%H:%M:%SZ)"
  else
    iso="$(date -u -r "$mtime" +%Y-%m-%dT%H:%M:%SZ)"
  fi
  printf 'candidate\t%s\t%s\t%s\t%s\n' "$dir" "$files" "$mtime" "$iso"
  if [ "$mtime" -gt "$best_mtime" ] || { [ "$mtime" -eq "$best_mtime" ] && [ "$files" -gt "$best_files" ]; }; then
    best_dir="$dir"; best_mtime="$mtime"; best_files="$files"
  fi
done

if [ -z "$best_dir" ]; then
  echo "どの候補にも空でない .agent/ が無い" >&2
  exit 3
fi
printf 'chosen\t%s\t最終更新が新しい（%s ファイル）\n' "$best_dir" "$best_files"
