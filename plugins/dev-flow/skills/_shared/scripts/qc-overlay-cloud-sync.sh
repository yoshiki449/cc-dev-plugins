#!/usr/bin/env bash
# qc-overlay-cloud-sync.sh
#
# クラウドセッションで、同じセッションに付けた別リポジトリ内の QC overlay を
# ~/.cc-plugins/overlay/qc/ へ同期する。render_qc_overlay_snippet.sh（Setup script に
# 貼り付ける方式）の代替で、overlay を含む private リポジトリ（cc-plugins 等）を
# 毎回セッションに付けておく運用向け。
#
# $CC_PLUGINS_OVERLAY_SOURCE_SUBPATH が未設定なら機能オフ（既定）。設定されていれば、
# セッションに付いた各リポジトリの中からそのサブパスを持つものを探し、中身をコピーする。
# QC overlay は plan/impl/test-spec/verify/qa/ship/test-model の7フェーズ全部が消費するため、
# 特定フェーズの実行時ではなくセッション開始時（cloud-session-start.sh から呼ばれる）に
# 同期しておく必要がある。
#
# 探索は cloud-stack.sh の repos() と同じ考え方: ROOT 直下を1階層だけ列挙し、.git を持つ
# ディレクトリを候補にし、既知の相対パスを持つものだけを対象にする。クローン先ディレクトリの
# 名前がリポジトリ名と一致するかという命名規則には一切依存しない。
#
# overlay は任意機能なので、見つからなくても失敗として扱わない
# （cloud-session-start.sh から `|| true` で呼ばれる前提）。
set -uo pipefail

SUBPATH="${CC_PLUGINS_OVERLAY_SOURCE_SUBPATH:-}"
[ -n "$SUBPATH" ] || exit 0

ROOT="${CLOUD_STACK_ROOT:-${CLAUDE_PROJECT_DIR:-$PWD}}"
DEST="${CC_PLUGINS_OVERLAY_DIR:-$HOME/.cc-plugins/overlay/qc}"
LOG="$HOME/.cc-plugins/.overlay-sync.log"
mkdir -p "$(dirname "$LOG")"

# qc-overlay.sh の PHASES / render_qc_overlay_snippet.sh の NAMES と同じ一覧の3箇所目の
# 重複。頻度の低い変更なので、直前のセルフレビューでの判断を踏襲しあえて共通化しない。
NAMES=(manifest.json plan.md impl.md test-spec.md verify.md qa.md ship.md test-model.md)

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

is_candidate() {
  local dir="$1"
  # -s: 存在しかつ0バイトでない。0バイトの manifest.json は貼り付け先で
  # 「読めない」扱いになり結局 overlay_applied=0 になるため候補として数えない
  # （render_qc_overlay_snippet.sh のセルフレビューで見つかった不具合の再発防止）。
  [ -e "$dir/.git" ] && [ -s "$dir/$SUBPATH/manifest.json" ]
}

CANDIDATES=()
if is_candidate "$ROOT"; then
  CANDIDATES+=("$ROOT")
else
  for d in "$ROOT"/*/; do
    d=${d%/}
    is_candidate "$d" && CANDIDATES+=("$d")
  done
fi

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  log "見つからない: CC_PLUGINS_OVERLAY_SOURCE_SUBPATH=$SUBPATH を持つリポジトリが無い（root=$ROOT）"
  exit 0
fi

# 複数見つかったら sort で決定的に1つ選ぶ。黙って選ばず、選ばれなかった側もログに残す。
SORTED=$(printf '%s\n' "${CANDIDATES[@]}" | sort)
CHOSEN=$(printf '%s\n' "$SORTED" | head -1)
if [ "${#CANDIDATES[@]}" -gt 1 ]; then
  SKIPPED=$(printf '%s\n' "$SORTED" | tail -n +2 | tr '\n' ' ')
  log "候補が複数（$CHOSEN を採用、除外: $SKIPPED）"
fi

SRC="$CHOSEN/$SUBPATH"
mkdir -p -m 700 "$DEST"
copied=0
for name in "${NAMES[@]}"; do
  [ -f "$SRC/$name" ] || continue
  cp -f "$SRC/$name" "$DEST/$name"
  chmod 600 "$DEST/$name"
  copied=$((copied + 1))
done

log "同期元: $SRC / コピー: ${copied}件"
exit 0
