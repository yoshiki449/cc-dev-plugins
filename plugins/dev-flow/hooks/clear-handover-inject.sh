#!/bin/bash
# /clear 後の引継書要約の自動注入（SessionStart, matcher: clear）。Issue #67。
# stdin の source が clear のときだけ、cwd の .agent/handover-*.md から1件を選び、
# 要約（パス・直前/次フェーズ・作業場所）を標準出力へ出す。全文は出さない。
# 選び方: ブランチ名の issue<N> の引継書を優先。無ければ全体の最新を注意書きつきで出す。
# 「最新」の判定は latest-handover.sh に一本化している。常に exit 0（セッション開始を止めない）。
INPUT=$(cat)
SCRIPTS="$(cd "$(dirname "$0")/../skills/_shared/scripts" 2>/dev/null && pwd)" || exit 0

SOURCE=$(echo "$INPUT" | jq -r '.source // empty' 2>/dev/null)
[ "$SOURCE" = "clear" ] || exit 0
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] && [ -d "$CWD" ] || exit 0

# サブディレクトリで /clear されても、リポジトリ直下の .agent/ を基準にする。git 外なら cwd のまま。
TOP=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
[ -n "$TOP" ] && [ -d "$TOP" ] && CWD="$TOP"

BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null)
BRANCH_ISSUE=""
if [[ $BRANCH =~ (^|[^a-z])issue-?([0-9]+) ]]; then
  BRANCH_ISSUE="${BASH_REMATCH[2]}"
fi

REL=""
NOTE=""
if [ -n "$BRANCH_ISSUE" ]; then
  REL=$("$SCRIPTS/latest-handover.sh" "$CWD" "$BRANCH_ISSUE" 2>/dev/null)
  if [ -z "$REL" ]; then
    REL=$("$SCRIPTS/latest-handover.sh" "$CWD" 2>/dev/null)
    NOTE="注意: ブランチの Issue #$BRANCH_ISSUE の引継書は無く、別 Issue のものです。"
  fi
else
  REL=$("$SCRIPTS/latest-handover.sh" "$CWD" 2>/dev/null)
  NOTE="注意: ブランチ名から Issue を特定できないため、別 Issue の引継書の可能性があります。"
fi
[ -n "$REL" ] || exit 0

HANDOVER="$(cd "$CWD" && pwd -P)/$REL"
[ -r "$HANDOVER" ] || exit 0

NAME=$(basename "$HANDOVER")
CREATED=""
if [[ $NAME =~ ^handover-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})[-.] ]]; then
  CREATED="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}"
elif [[ $NAME =~ ^handover-([0-9]{4})([0-9]{2})([0-9]{2})[-.] ]]; then
  CREATED="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
fi

# UTF-8 ロケールを探す（C.UTF-8 優先、次に en_US.UTF-8。utf8/UTF-8・大小文字の表記ゆれを許す）。
# 無ければ空のまま。export LC_ALL を無条件に行うと、無いロケールで setlocale 警告が stderr に出る。
UTF8_LOC=""
if command -v locale >/dev/null 2>&1; then
  LOCALES=$(locale -a 2>/dev/null)
  for pat in '^c\.utf-?8$' '^en_us\.utf-?8$'; do
    UTF8_LOC=$(printf '%s\n' "$LOCALES" | grep -iE "$pat" | head -n 1)
    [ -n "$UTF8_LOC" ] && break
  done
fi

# 先頭200文字に切る。UTF-8 ロケールがあればそのまま文字単位で切る。
# 無ければバイト単位（最大600バイト）で切り、iconv -c で不完全な末尾を落としてから200文字に再度切る。
cut_200() {
  local v="$1"
  if [ -n "$UTF8_LOC" ]; then
    (export LC_ALL="$UTF8_LOC"; printf '%s' "${v:0:200}")
    return
  fi
  local b
  b=$(export LC_ALL=C; printf '%s' "${v:0:600}")
  if command -v iconv >/dev/null 2>&1; then
    b=$(printf '%s' "$b" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null)
  fi
  printf '%s' "$b" | LC_ALL=C sed -E 's/^(([^\x80-\xFF]|[\xC0-\xFF][\x80-\xBF]*){200}).*/\1/'
}

# 行頭が「- <ラベル>:」の行だけを対象に、値のある最初の行を使う。CR を除き、先頭200文字まで。
phase_line() {
  local label="$1" line v
  while IFS= read -r line; do
    line=${line%$'\r'}
    v=${line#"- $label:"}
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    if [ -n "$v" ]; then
      echo "$label: $(cut_200 "$v")"
      return
    fi
  done < <(grep -E "^- $label:" "$HANDOVER" 2>/dev/null)
}
PREV=$(phase_line 直前フェーズ)
NEXT=$(phase_line 次フェーズ)

# 作業場所のパスは resume-prompt.sh の2行目を再利用する（1行目の再開プロンプトは使わない）。
# ブランチは cwd のもの。worktree 欄のパスが実在しないと resume-prompt 側ではブランチを取れないため、
# 括弧の中身はここで組み立てる。Issue 番号は選ばれた引継書のもの。
WORKLINE=$(cd "$CWD" && "$SCRIPTS/resume-prompt.sh" dev-resume "$HANDOVER" 2>/dev/null | sed -n 2p)
WORKPATH=${WORKLINE#作業場所: }
WORKPATH=${WORKPATH%%（*}
ISSUE=$("$SCRIPTS/extract-issue-number.sh" "$HANDOVER" 2>/dev/null)
DETAIL=""
[ -n "$BRANCH" ] && DETAIL="ブランチ: $BRANCH"
[ -n "$ISSUE" ] && DETAIL="${DETAIL:+$DETAIL、}Issue: #$ISSUE"
WORKPLACE=""
if [ -n "$WORKPATH" ]; then
  WORKPLACE="作業場所: $WORKPATH"
  [ -n "$DETAIL" ] && WORKPLACE="$WORKPLACE（$DETAIL）"
fi

# 鮮度警告: 引継書より後のコミット数。件名は出さない（他者が書ける文字列を混ぜない）。
# 追跡済みでクリーン → 最後に変更したコミット B の B..HEAD。それ以外 → mtime より厳密に新しい committer date。
# git の失敗では止めない（失敗したら警告なし）。外部入力は引数として渡し、評価しない。
STALE=""
stale_count() {
  local base mtime
  git -C "$CWD" rev-parse --verify -q HEAD >/dev/null 2>&1 || return 0
  if git -C "$CWD" ls-files --error-unmatch -- "$REL" >/dev/null 2>&1 \
     && [ -z "$(git -C "$CWD" status --porcelain -- "$REL" 2>/dev/null)" ]; then
    base=$(git -C "$CWD" log -1 --format=%H -- "$REL" 2>/dev/null)
    [ -n "$base" ] || return 0
    git -C "$CWD" rev-list --count "$base..HEAD" 2>/dev/null
  else
    mtime=$(stat -c %Y "$HANDOVER" 2>/dev/null || stat -f %m "$HANDOVER" 2>/dev/null)
    [[ $mtime =~ ^[0-9]+$ ]] || return 0
    git -C "$CWD" log --format=%ct HEAD 2>/dev/null | awk -v m="$mtime" '$1 > m { n++ } END { print n + 0 }'
  fi
}
STALE_N=$(stale_count)
if [[ $STALE_N =~ ^[0-9]+$ ]] && [ "$STALE_N" -gt 0 ]; then
  STALE_HASH=$(git -C "$CWD" rev-parse --short HEAD 2>/dev/null)
  STALE_WHEN=$(git -C "$CWD" log -1 --format=%cd --date="format:%Y-%m-%d %H:%M %z" HEAD 2>/dev/null)
  if [ -n "$STALE_HASH" ] && [ -n "$STALE_WHEN" ]; then
    STALE="注意: この引継書の後に $STALE_N 件のコミットがある（最新: $STALE_HASH、$STALE_WHEN）。引継書が現状を反映していない可能性があるので、git log で確かめること。"
  fi
fi

echo "## 前回フェーズの引継書（/clear 後の自動注入）"
if [ -n "$CREATED" ]; then
  echo "引継書: $HANDOVER（作成: $CREATED）"
else
  echo "引継書: $HANDOVER"
fi
[ -n "$NOTE" ] && echo "$NOTE"
[ -n "$STALE" ] && echo "$STALE"
[ -n "$PREV" ] && echo "$PREV"
[ -n "$NEXT" ] && echo "$NEXT"
[ -n "$WORKPLACE" ] && echo "$WORKPLACE"
echo "状況を答える前に、この引継書を読むこと。貼られた再開プロンプトに引継書のパスがあれば、そちらを優先する。"
exit 0
