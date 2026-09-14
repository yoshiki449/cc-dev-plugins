#!/usr/bin/env bash
# 最新の引継書ファイルパスを返す（無ければ空文字＋exit 0）
# 使い方: latest-handover.sh [dir]
set -euo pipefail

cd "${1:-.}"

shopt -s nullglob
files=(.agent/handover-*.md)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  exit 0
fi

# 「最新」はファイル名の日付で決める。mtime を使わないのは、dev-setup B1-3 が .agent/ を
# worktree へコピーする経路を持っており、コピー後は全ファイルの mtime がほぼ同時刻に揃って
# 順序が不定になるため。生成側 new-handover-path.sh が必ず handover-YYYYMMDD-HHMM を作る。
#
# 単純な辞書順（旧実装の ls | sort | tail -1）は使えない。日付を持たない引継書
# （handover-257.md / handover-issue62.md 等が実在する）が ASCII 比較で常に末尾に来て、
# 古い引継書を「最新」として返していた（Issue #52）。
dated=()
undated=()
for f in "${files[@]}"; do
  b=${f##*/}
  if [[ $b =~ ^handover-([0-9]{8})-([0-9]{4})[-.] ]]; then
    dated+=("${BASH_REMATCH[1]}${BASH_REMATCH[2]}"$'\t'"$f")
  elif [[ $b =~ ^handover-([0-9]{8})[-.] ]]; then
    # 時刻なしの命名は同日の時刻つきより古いものとして扱う
    dated+=("${BASH_REMATCH[1]}0000"$'\t'"$f")
  else
    undated+=("$f")
  fi
done

if [ ${#dated[@]} -gt 0 ]; then
  if [ ${#undated[@]} -gt 0 ]; then
    echo "WARN: 日付を持たない引継書 ${#undated[@]} 件を最新判定から除外した: ${undated[*]##*/}" >&2
  fi
  # 第2キーにパスを置いて、同じ日付が並んでも結果が実行ごとに変わらないようにする
  printf '%s\n' "${dated[@]}" | LC_ALL=C sort -t$'\t' -k1,1 -k2,2 | tail -n 1 | cut -f2-
  exit 0
fi

# 日付つきが1件も無いときだけ mtime にフォールバックする。
# 順序の根拠が弱いので、判定に使えなかったことを呼び出し側に伝える。
#
# `| head -n 1` は使えない。pipefail 下で head が先に閉じると ls が SIGPIPE で
# 落ち、パイプライン全体が exit 141 になる。set -e と合わさってスクリプトが
# 無音停止し、呼び出し元の extract-issue-number.sh まで連鎖する。
mapfile -t by_mtime < <(ls -1t "${undated[@]}")
newest="${by_mtime[0]}"
echo "WARN: 日付を持つ引継書が無いため、更新時刻が最新の ${newest##*/} を返す" >&2
echo "$newest"
