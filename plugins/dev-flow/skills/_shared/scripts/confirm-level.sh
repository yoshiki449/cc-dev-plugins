#!/usr/bin/env bash
# confirm-level.sh
#
# dev-flow の「確認レベル」（strict | light）を判定し、JSON 1 行で返す。
# 設定は docs/dev-flow/confirm-level.conf の `confirm_level=<値>`。
#
# ⚠ 読むのは「ローカルにある origin 既定ブランチの ref」上のファイルだけ。
#   作業ツリーの light 宣言を有効にすると、作業中の変更で自分の確認を緩められる。
#   作業ツリー側は「未マージの light 宣言」を警告するためにだけ見る。
#
# 使い方:
#   bash confirm-level.sh --dir <リポジトリ内のディレクトリ>
#
# 出力: 常に JSON 1 行を stdout に出し exit 0。判定不能は strict に倒す。
#   呼び出し側の set -e を殺さないため、引数エラーでも非ゼロで終わらない。

# あえて set -e を使わない。git の失敗や不在ファイルは正常な分岐であり、
# -e があると JSON を出す前に落ちる。

CONF_PATH="docs/dev-flow/confirm-level.conf"
DIR=""
LEVEL="strict"
SOURCE="default"
FILE=""
WARNINGS=()

# 環境の git 設定・ホームの設定に判定を左右させない
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1

json_escape() {
  local s="$1" out="" ch i code
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  for ((i = 0; i < ${#s}; i++)); do
    ch="${s:i:1}"
    printf -v code '%d' "'$ch"
    if ((code < 32)); then
      printf -v ch '\\u%04x' "$code"
    fi
    out+="$ch"
  done
  printf '%s' "$out"
}

json_array() {
  local out="[" first=1 item
  for item in "$@"; do
    [[ $first -eq 1 ]] || out+=","
    first=0
    out+="\"$(json_escape "$item")\""
  done
  printf '%s]' "$out"
}

emit() {
  printf '{"level":"%s","source":"%s","file":"%s","warnings":%s}\n' \
    "$LEVEL" "$(json_escape "$SOURCE")" "$(json_escape "$FILE")" \
    "$(json_array "${WARNINGS[@]}")"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      if [[ $# -ge 2 ]]; then DIR="$2"; shift 2; else DIR=""; shift; fi
      ;;
    *) shift ;;
  esac
done

if [[ -z "$DIR" ]]; then
  WARNINGS+=("--dir が指定されていない。strict で扱う")
  emit
fi

if [[ ! -d "$DIR" ]]; then
  WARNINGS+=("--dir のパスが存在しない: $DIR。strict で扱う")
  emit
fi

ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$ROOT" ]]; then
  WARNINGS+=("--dir が git リポジトリではない: $DIR。strict で扱う")
  emit
fi

# origin/HEAD が指すブランチ → origin/main → origin/master の順
REF=""
HEAD_REF="$(git -C "$ROOT" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)"
HEAD_REF="${HEAD_REF#refs/remotes/}"
for cand in "$HEAD_REF" origin/main origin/master; do
  [[ -n "$cand" ]] || continue
  if git -C "$ROOT" rev-parse -q --verify "refs/remotes/$cand^{commit}" >/dev/null 2>&1; then
    REF="$cand"
    break
  fi
done

if [[ -z "$REF" ]]; then
  WARNINGS+=("origin の既定ブランチの ref を確認できない。strict で扱う")
  emit
fi

# confirm_level の宣言を数える。引数: 内容（改行区切り）
# 結果は PARSED_VALUE / PARSED_COUNT / PARSED_UNKNOWN に入れる。
parse_conf() {
  local content="$1" line key value
  PARSED_VALUE=""
  PARSED_COUNT=0
  PARSED_UNKNOWN=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      PARSED_UNKNOWN=1
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ "$key" == "confirm_level" ]]; then
      PARSED_COUNT=$((PARSED_COUNT + 1))
      PARSED_VALUE="$value"
    else
      PARSED_UNKNOWN=1
    fi
  done <<<"$content"
}

# `$()` は末尾の改行を落とすが、行単位で読むので最終行の改行有無は影響しない。
REF_CONTENT=""
REF_HAS_FILE=0
if git -C "$ROOT" cat-file -e "$REF:$CONF_PATH" 2>/dev/null; then
  REF_HAS_FILE=1
  REF_CONTENT="$(git -C "$ROOT" show "$REF:$CONF_PATH" 2>/dev/null)"
fi

if [[ $REF_HAS_FILE -eq 1 ]]; then
  SOURCE="$REF:$CONF_PATH"
  FILE="$CONF_PATH"
  parse_conf "$REF_CONTENT"
  if [[ $PARSED_UNKNOWN -eq 1 ]]; then
    WARNINGS+=("未知のキーを無視した: $CONF_PATH")
  fi
  if [[ $PARSED_COUNT -eq 0 ]]; then
    WARNINGS+=("confirm_level の指定が無い。strict で扱う")
  elif [[ $PARSED_COUNT -gt 1 ]]; then
    WARNINGS+=("confirm_level の値が不正値（キーの重複）。strict で扱う")
    WARNINGS+=("confirm_level のキーの重複がある")
  elif [[ "$PARSED_VALUE" == "light" ]]; then
    LEVEL="light"
  elif [[ "$PARSED_VALUE" != "strict" ]]; then
    WARNINGS+=("confirm_level の値が不正値。strict で扱う")
  fi
fi

# ref 上が light なら作業ツリーは見ない。それ以外で作業ツリーが light を宣言していたら警告する
if [[ "$LEVEL" != "light" && -f "$ROOT/$CONF_PATH" ]]; then
  parse_conf "$(cat "$ROOT/$CONF_PATH" 2>/dev/null)"
  if [[ $PARSED_COUNT -eq 1 && "$PARSED_VALUE" == "light" ]]; then
    WARNINGS+=("未マージの light 宣言は無視した。$REF に取り込まれるまで strict")
  fi
fi

emit
