#!/usr/bin/env bash
# resolve-base-ref.sh
#
# 差分の比較元（base）を1本で決める共通ヘルパー。dev-flow の SKILL.md・エージェント・
# workflow・assess-change-size.sh が `main...HEAD` などを直書きする代わりに、これの出力
# （base）を `<BASE>...HEAD` として使う。
#
# 直書きをやめる理由: 統合ブランチが develop のリポジトリや、ローカルの main が
# origin/main より古い worktree 運用では、main...HEAD が無関係な変更を拾う。差分が取れて
# しまうので台帳・レビュー・規模判定の出力を見ても混入に気づけない（静かに壊れる）。
#
# 使い方:
#   bash resolve-base-ref.sh [--dir <repo>] [--base <ref>] [--head <ref>] [--no-fetch] [--help]
#
# 決め方（上から順。最初に決まったものを採る）:
#   1. --base（実在確認する）                              source=explicit
#   2. 現在のブランチの既存 PR の base（gh があるときだけ） source=pr
#      候補に無い release/* などもそのまま採る。origin/<base> が無ければ警告して次へ
#   3. 候補のうち HEAD までのコミット数が最少のもの          source=nearest
#      候補: origin/HEAD の指す先 → origin/develop → origin/main → origin/master → origin/trunk
#      同数なら先に挙げた方。ローカルのブランチは候補にしない（古いことが多いため）
#   決める前に `git fetch origin` を最大10秒で試す（失敗は警告にとどめる。--no-fetch で止める）。
#
# 終了コード:
#   0: 決定
#   2: 決められない・引数エラー（呼び出し側は中断してユーザーに比較元を尋ねる。
#      main へ黙って落ちない）
#
# 出力: stdout に JSON 1 行。
#   {"base":"origin/develop","source":"nearest","candidates":[{"ref":"origin/develop","ahead":3}],"warnings":[]}
#   決められないとき base は null で、error に理由が入る。

# git hook 実行中などでは GIT_DIR 等が export されていて `git -C` が負ける。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

print_usage() {
  cat >&2 <<'USAGE'
usage: resolve-base-ref.sh [--dir <repo>] [--base <ref>] [--head <ref>] [--no-fetch]
exit: 0=決定 / 2=決められない（呼び出し側で中断してユーザーに聞く）
USAGE
}

json_escape() {
  local s="$1"
  case "$s" in
    *[\\\"$'\x01'-$'\x1f']*) ;;
    *) printf '%s' "$s"; return ;;
  esac
  local out="" i len c n
  len=${#s}
  for (( i = 0; i < len; i++ )); do
    c="${s:i:1}"
    case "$c" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\b') out+='\b' ;;
      $'\t') out+='\t' ;;
      $'\n') out+='\n' ;;
      $'\f') out+='\f' ;;
      $'\r') out+='\r' ;;
      *)
        printf -v n '%d' "'$c"
        if (( n >= 0 && n <= 31 )); then
          printf -v out '%s\u%04x' "$out" "$n"
        else
          out+="$c"
        fi
        ;;
    esac
  done
  printf '%s' "$out"
}

# --end-of-options を付けるのは、--output= のような値をオプションと解釈させないため
# （assess-change-size.sh の verify_ref と同じ方針）。
verify_ref() {
  local ref="$1"
  [[ -z "$ref" ]] && return 1
  git -C "$ROOT" rev-parse --verify --quiet --end-of-options "${ref}^{commit}" >/dev/null 2>&1
}

WARNINGS=()
CANDIDATES_JSON=""

emit() {
  local base="$1" source="$2" error="${3:-}" out w first=1
  out="{"
  if [[ -n "$base" ]]; then
    out+="\"base\":\"$(json_escape "$base")\",\"source\":\"$(json_escape "$source")\","
  else
    out+="\"base\":null,\"source\":null,\"error\":\"$(json_escape "$error")\","
  fi
  out+="\"candidates\":[${CANDIDATES_JSON}],\"warnings\":["
  for w in "${WARNINGS[@]}"; do
    if [[ $first -eq 1 ]]; then first=0; else out+=","; fi
    out+="\"$(json_escape "$w")\""
  done
  out+="]}"
  printf '%s\n' "$out"
}

fail() {
  emit "" "" "$1"
  printf 'resolve-base-ref: %s\n' "$1" >&2
  exit 2
}

DIR="$PWD"
BASE_ARG=""
BASE_SET=0
HEAD_REF="HEAD"
HEAD_SET=0
DO_FETCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      DIR="$2"; shift 2 ;;
    --base)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      BASE_ARG="$2"; BASE_SET=1; shift 2 ;;
    --head)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      HEAD_REF="$2"; HEAD_SET=1; shift 2 ;;
    --no-fetch)
      DO_FETCH=0; shift ;;
    *)
      print_usage; exit 2 ;;
  esac
done

[[ -d "$DIR" ]] || fail "指定ディレクトリが存在しない: $DIR"
ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
[[ -n "$ROOT" ]] || fail "git リポジトリではない: $DIR"

if [[ $HEAD_SET -eq 1 ]]; then
  verify_ref "$HEAD_REF" || fail "指定された ref を解決できない（--head）: $HEAD_REF"
fi

# 1. 明示指定
if [[ $BASE_SET -eq 1 ]]; then
  verify_ref "$BASE_ARG" || fail "指定された ref を解決できない（--base）: $BASE_ARG"
  emit "$BASE_ARG" "explicit"
  exit 0
fi

# 決める前に追跡ブランチを新しくする。古いままだと最短距離の選択を誤る。
# 失敗（オフライン・認証切れ）は警告にとどめて続行する。origin が無いなら何もしない。
if [[ $DO_FETCH -eq 1 ]] && git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
  if ! GIT_TERMINAL_PROMPT=0 timeout 10 git -C "$ROOT" fetch --quiet origin >/dev/null 2>&1; then
    WARNINGS+=("git fetch origin に失敗した（オフライン・認証・タイムアウト）。追跡ブランチが古い可能性がある")
  fi
fi

# 2. 既存 PR の base（gh があるときだけ）。HEAD 以外を指定されたときはブランチが特定できないので飛ばす。
if [[ $HEAD_SET -eq 0 ]] && command -v gh >/dev/null 2>&1; then
  PR_BASE="$(cd "$ROOT" && GH_PROMPT_DISABLED=1 timeout 10 gh pr view --json baseRefName --jq .baseRefName 2>/dev/null)"
  PR_BASE="${PR_BASE//$'\r'/}"
  if [[ -n "$PR_BASE" && "$PR_BASE" != -* ]]; then
    if verify_ref "origin/$PR_BASE"; then
      emit "origin/$PR_BASE" "pr"
      exit 0
    fi
    WARNINGS+=("PR の base origin/$PR_BASE が見つからないので最短距離で決める")
  fi
fi

# 3. 候補のうち HEAD までのコミット数が最少のもの。同数なら先に挙げた方（厳密な < で更新）。
CAND_REFS=()
ORIGIN_HEAD="$(git -C "$ROOT" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"
[[ -n "$ORIGIN_HEAD" ]] && CAND_REFS+=("${ORIGIN_HEAD#refs/remotes/}")
for c in origin/develop origin/main origin/master origin/trunk; do
  dup=0
  for e in "${CAND_REFS[@]}"; do [[ "$e" == "$c" ]] && dup=1; done
  [[ $dup -eq 0 ]] && CAND_REFS+=("$c")
done

BEST=""
BEST_N=-1
for c in "${CAND_REFS[@]}"; do
  verify_ref "$c" || continue
  n="$(git -C "$ROOT" rev-list --count --end-of-options "${c}..${HEAD_REF}" 2>/dev/null)"
  [[ "$n" =~ ^[0-9]+$ ]] || continue
  [[ -n "$CANDIDATES_JSON" ]] && CANDIDATES_JSON+=","
  CANDIDATES_JSON+="{\"ref\":\"$(json_escape "$c")\",\"ahead\":$n}"
  if [[ $BEST_N -lt 0 || $n -lt $BEST_N ]]; then
    BEST="$c"; BEST_N=$n
  fi
done

if [[ -z "$BEST" ]]; then
  fail "比較元の候補（origin/develop・origin/main・origin/master・origin/trunk）が1つも見つからない。--base で指定するかユーザーに尋ねる"
fi

emit "$BEST" "nearest"
exit 0
