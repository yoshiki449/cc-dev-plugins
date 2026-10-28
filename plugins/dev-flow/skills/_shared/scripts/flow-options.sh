#!/usr/bin/env bash
# flow-options.sh
#
# プロジェクトごとの「要否」設定（explain-diff・手動テスト仕様書）を読み、JSON 1 行で返す。
# 設定は docs/dev-flow/flow-options.conf の `キー=on|off`。
#
# ⚠ confirm-level.sh と同じく、読むのは「ローカルにある origin 既定ブランチの ref」上のファイルだけ。
#   未マージの宣言は無視して unset（従来どおり質問・既定動作）に倒し、警告だけ出す。
#
# 使い方:
#   bash flow-options.sh --dir <リポジトリ内のディレクトリ>
#
# 出力: 常に JSON 1 行を stdout に出し exit 0。判定不能・不正値・重複はそのキーを unset にする。
#   {"explain_diff":"unset","test_spec":"on","source":"","warnings":[]}

# あえて set -e を使わない（git の失敗や不在ファイルは正常な分岐）。

CONF_PATH="docs/dev-flow/flow-options.conf"
KEYS=(explain_diff test_spec)
MAX_CONF_BYTES=65536
DIR=""
SOURCE=""
WARNINGS=()
declare -A VAL COUNT
for k in "${KEYS[@]}"; do VAL[$k]="unset"; COUNT[$k]=0; done

for _v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$_v"; done
unset _v
export GIT_NO_REPLACE_OBJECTS=1
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

json_escape() {
  local s="$1" out="" ch i code
  # 非 ASCII を含む不正な UTF-8 は JSON を壊すので置き換える
  if command -v iconv >/dev/null 2>&1 && ! printf '%s' "$s" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
    s="(不正な文字列)"
  fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  for ((i = 0; i < ${#s}; i++)); do
    ch="${s:i:1}"
    printf -v code '%d' "'$ch"
    if ((code < 32)); then printf -v ch '\\u%04x' "$code"; fi
    out+="$ch"
  done
  printf '%s' "$out"
}

emit() {
  local out="" first=1 w
  for w in "${WARNINGS[@]}"; do
    [[ $first -eq 1 ]] || out+=","
    first=0
    out+="\"$(json_escape "$w")\""
  done
  printf '{"explain_diff":"%s","test_spec":"%s","source":"%s","warnings":[%s]}\n' \
    "${VAL[explain_diff]}" "${VAL[test_spec]}" "$(json_escape "$SOURCE")" "$out"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) if [[ $# -ge 2 ]]; then DIR="$2"; shift 2; else DIR=""; shift; fi ;;
    *) shift ;;
  esac
done

[[ -n "$DIR" ]] || { WARNINGS+=("--dir が指定されていない。すべて unset で扱う"); emit; }
[[ -d "$DIR" ]] || { WARNINGS+=("--dir のパスが存在しない。すべて unset で扱う"); emit; }
ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
[[ -n "$ROOT" ]] || { WARNINGS+=("--dir が git リポジトリではない。すべて unset で扱う"); emit; }

REF="" REF_SHA=""
HEAD_REF="$(git -C "$ROOT" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)"
HEAD_REF="${HEAD_REF#refs/remotes/}"
for cand in "$HEAD_REF" origin/main origin/master; do
  [[ -n "$cand" ]] || continue
  if REF_SHA="$(git -C "$ROOT" rev-parse -q --verify "refs/remotes/$cand^{commit}" 2>/dev/null)"; then
    REF="$cand"
    break
  fi
done
[[ -n "$REF" ]] || { WARNINGS+=("origin の既定ブランチの ref を確認できない。すべて unset で扱う"); emit; }

# 引数: 内容（改行区切り）。結果は PARSED_VAL / PARSED_COUNT（連想配列）と PARSED_UNKNOWN に入れる
declare -A PARSED_VAL PARSED_COUNT
PARSED_UNKNOWN=0
parse_conf() {
  local line key value k
  PARSED_VAL=(); PARSED_COUNT=(); PARSED_UNKNOWN=0
  for k in "${KEYS[@]}"; do PARSED_COUNT[$k]=0; done
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then PARSED_UNKNOWN=1; continue; fi
    key="${line%%=*}"; value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    for k in "${KEYS[@]}"; do
      if [[ "$key" == "$k" ]]; then
        PARSED_COUNT[$k]=$((PARSED_COUNT[$k] + 1))
        PARSED_VAL[$k]="$value"
        continue 2
      fi
    done
    PARSED_UNKNOWN=1
  done <<<"$1"
}

# 完全修飾名から求めた SHA で読む（同名のタグ・ブランチに ref を上書きされないため）
if git -C "$ROOT" cat-file -e "$REF_SHA:$CONF_PATH" 2>/dev/null; then
  SOURCE="$REF:$CONF_PATH"
  SIZE="$(git -C "$ROOT" cat-file -s "$REF_SHA:$CONF_PATH" 2>/dev/null)"
  if [[ "$SIZE" =~ ^[0-9]+$ && $SIZE -le $MAX_CONF_BYTES ]]; then
    parse_conf "$(git -C "$ROOT" show "$REF_SHA:$CONF_PATH" 2>/dev/null)"
    [[ $PARSED_UNKNOWN -eq 1 ]] && WARNINGS+=("未知のキーまたは書式を無視した: $CONF_PATH")
    for k in "${KEYS[@]}"; do
      if [[ ${PARSED_COUNT[$k]} -gt 1 ]]; then
        WARNINGS+=("$k が重複している。unset で扱う")
      elif [[ ${PARSED_COUNT[$k]} -eq 1 ]]; then
        case "${PARSED_VAL[$k]}" in
          on|off) VAL[$k]="${PARSED_VAL[$k]}" ;;
          *) WARNINGS+=("$k の値が不正値（on / off のみ）。unset で扱う") ;;
        esac
      fi
    done
  else
    WARNINGS+=("設定ファイルが大きすぎる。読まずに unset で扱う: $CONF_PATH")
  fi
elif [[ -f "$ROOT/$CONF_PATH" && ! -L "$ROOT/$CONF_PATH" ]]; then
  WARNINGS+=("$CONF_PATH は未マージ。$REF に取り込まれるまで無視して unset（従来どおり質問）")
fi

emit
