#!/usr/bin/env bash
# /dev-run の前提チェック。経路が plan / design を飛ばして始まるとき、未実施なら止めるための判定器。
# 使い方: run-preconditions.sh <フェーズ列(カンマ区切り 例: implement,verify,ship)> [dir]
# 出力: JSON 1 行 {"ok":bool,"missing":["plan"|"design"],"plan_handover":"<相対パス>","warnings":[...]}
# 常に exit 0。判断はスキル側（missing が空でなければ実行を始めない）。
#
# 判定は .agent/handover-*.md の1行目 `# 引継書 - <フェーズ> - ...` だけで行う。ブランチ名に
# issue<N> があれば同じ Issue の引継書だけを見る（無ければ全体を見て警告する）。
#   plan:   経路が design / setup / implement から始まるとき、plan の引継書が必要
#   design: 経路に design が無く、plan 引継書が `design フェーズ推奨: yes` で、design の引継書が無いとき不足
# fix / verify / qa / ship などから始まる経路（バグ修正・途中再開）は plan を要求しない。
set -uo pipefail

ROUTE="${1:-}"
DIR="${2:-.}"
cd "$DIR" 2>/dev/null || { printf '{"ok":false,"missing":[],"plan_handover":"","warnings":["ディレクトリを開けない"]}\n'; exit 0; }

if ! [[ $ROUTE =~ ^[a-z][a-z-]*(,[a-z][a-z-]*)*$ ]]; then
  printf '{"ok":false,"missing":[],"plan_handover":"","warnings":["フェーズ列が不正"]}\n'
  exit 0
fi
IFS=',' read -r -a PHASES <<<"$ROUTE"
FIRST="${PHASES[0]#dev-}"
has_phase() { local p; for p in "${PHASES[@]}"; do [ "${p#dev-}" = "$1" ] && return 0; done; return 1; }

BRANCH=$(git branch --show-current 2>/dev/null || true)
ISSUE=""
if [[ $BRANCH =~ (^|[^a-z])issue-?([0-9]+) ]]; then ISSUE="${BASH_REMATCH[2]}"; fi

WARN=()
shopt -s nullglob
ALL=(.agent/handover-*.md)
shopt -u nullglob
FILES=()
if [ -n "$ISSUE" ]; then
  for f in "${ALL[@]}"; do [[ ${f##*/} =~ issue${ISSUE}([^0-9]|$) ]] && FILES+=("$f"); done
else
  FILES=("${ALL[@]}")
  [ ${#ALL[@]} -gt 0 ] && WARN+=("ブランチ名から Issue を特定できないため、全 Issue の引継書を見ている")
fi

# 指定フェーズの引継書のうち、ファイル名で最後のものを返す（無ければ空）
find_phase() {
  local f hit=""
  for f in "${FILES[@]+"${FILES[@]}"}"; do
    if head -n 1 "$f" 2>/dev/null | grep -Eq "^# 引継書 - (dev-)?$1( |$)"; then hit="$f"; fi
  done
  printf '%s' "$hit"
}

MISSING=()
PLAN_H=$(find_phase plan)
case "$FIRST" in
  plan) : ;;
  design|setup|implement)
    [ -n "$PLAN_H" ] || MISSING+=("plan") ;;
esac

if [ -n "$PLAN_H" ] && [ "$FIRST" != "plan" ] && ! has_phase design; then
  if grep -Eq 'design フェーズ推奨:[ `*]*yes' "$PLAN_H" 2>/dev/null; then
    case "$FIRST" in
      design|setup|implement)
        [ -n "$(find_phase design)" ] || MISSING+=("design") ;;
    esac
  fi
fi

json_arr() { local out="" x; for x in "$@"; do x=${x//\\/\\\\}; x=${x//\"/\\\"}; out+="${out:+,}\"$x\""; done; printf '[%s]' "$out"; }
OK=true; [ ${#MISSING[@]} -gt 0 ] && OK=false
printf '{"ok":%s,"missing":%s,"plan_handover":"%s","warnings":%s}\n' \
  "$OK" "$(json_arr "${MISSING[@]+"${MISSING[@]}"}")" "$PLAN_H" "$(json_arr "${WARN[@]+"${WARN[@]}"}")"
