#!/usr/bin/env bash
# qc-overlay.sh
#
# 組織固有の品質観点（QC overlay）が差し込まれているかを判定し、JSON 1 行で返す。
# dev-flow 本体は組織固有の観点を同梱しない。overlay が無くても動作し、
# 観点が1つも適用されなかったことを呼び出し側が必ず報告できるようにするのがこの判定器の役目。
#
# 契約の正はこのスクリプト本体と skills/_shared/reference/qc-overlay.md。
#
# 使い方:
#   bash qc-overlay.sh --phase <plan|impl|test-spec|verify|qa|ship|test-model> [--overlay-dir <path>]
#
# 終了コード:
#   0: 判定完了（overlay が無い場合も 0）
#   2: 引数エラー・--help
#
# 出力: 常に JSON 1 行を stdout に出す。呼び出し側の set -e を殺さないため、
# 判定不能でも stdout に JSON を出して exit 0 する。
#
# ⚠ 判定材料は overlay_present（manifest が読めたか）ではなく overlay_applied
#   （観点が1件以上あるフェーズファイルを読めたか）。理由は qc-overlay.md の
#   「判定材料を overlay_present ではなく overlay_applied にしている理由」に書いた。
#   配布物がコメントだけの空雛形で届くと present では警告が消える。

# あえて set -e を使わない。ファイルが無い・読めないは正常な分岐であり、
# -e があると JSON を出す前に落ちる。

PHASES="plan impl test-spec verify qa ship test-model"
PHASE=""
OVERLAY_DIR=""
WARNINGS=()

print_usage() {
  cat <<'USAGE' >&2
qc-overlay.sh — 組織固有の QC overlay の適用状況を判定する

  bash qc-overlay.sh --phase <phase> [--overlay-dir <path>]

  --phase <phase>        plan | impl | test-spec | verify | qa | ship | test-model
  --overlay-dir <path>   overlay の置き場所。既定は $CC_PLUGINS_OVERLAY_DIR、
                         未設定なら ~/.cc-plugins/overlay/qc
  --help                 このヘルプ

overlay の構成・manifest.json の書き方は
skills/_shared/reference/qc-overlay.md を参照。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --overlay-dir) OVERLAY_DIR="$2"; shift 2 ;;
    --help|-h) print_usage; exit 2 ;;
    *) echo "ERROR: 不明な引数: $1" >&2; print_usage; exit 2 ;;
  esac
done

if [[ -z "$PHASE" ]]; then
  echo "ERROR: --phase は必須です" >&2
  print_usage
  exit 2
fi

case " $PHASES " in
  *" $PHASE "*) ;;
  *) echo "ERROR: 未知のフェーズ: $PHASE（有効: $PHASES）" >&2; exit 2 ;;
esac

if [[ -z "$OVERLAY_DIR" ]]; then
  OVERLAY_DIR="${CC_PLUGINS_OVERLAY_DIR:-$HOME/.cc-plugins/overlay/qc}"
fi

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
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
  local present="$1" applied="$2" file="$3" items="$4" agent="$5"
  printf '{"phase":"%s","overlay_present":%d,"overlay_applied":%d,"file":"%s","items":%d,"reviewer_agent":"%s","warnings":%s}\n' \
    "$(json_escape "$PHASE")" "$present" "$applied" \
    "$(json_escape "$file")" "$items" "$(json_escape "$agent")" \
    "$(json_array "${WARNINGS[@]}")"
  exit 0
}

# manifest.json から1つの文字列値を取り出す。
# manifest はフラットなオブジェクトだけを想定する（qc-overlay.md に明記）。
# 取り出せなかったら空文字を返す。呼び出し側が warnings で音を立てる。
extract_string() {
  local flat="$1" key="$2"
  printf '%s' "$flat" \
    | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/'
}

# 観点の件数を数える。表のデータ行と箇条書き行だけを数え、
# コードフェンス内・HTML コメント・見出し・表の区切り行と見出し行は数えない。
# 見出し行は「次の行が区切り行であること」で判別する。
# ⚠ 見出しと区切りだけの空テーブルが items=0 になることが、空雛形で警告が消える穴を
#   塞いでいる本体。数え方を緩めないこと。
count_items() {
  awk '
    { lines[NR] = $0 }
    END {
      fence = 0
      n = 0
      for (i = 1; i <= NR; i++) {
        l = lines[i]
        if (l ~ /^[[:space:]]*```/) { fence = 1 - fence; continue }
        if (fence) continue
        if (l ~ /^[[:space:]]*<!--/) continue
        if (l ~ /^[[:space:]]*#/) continue
        if (l ~ /^[[:space:]]*\|/) {
          if (is_sep(l)) continue
          nxt = (i < NR) ? lines[i + 1] : ""
          if (is_sep(nxt)) continue
          n++
          continue
        }
        if (l ~ /^[[:space:]]*[-*+][[:space:]]/) n++
      }
      print n + 0
    }
    function is_sep(s) {
      if (s !~ /^[[:space:]]*\|/) return 0
      gsub(/[[:space:]]/, "", s)
      return (s ~ /^\|[-:|]+\|?$/)
    }
  ' "$1"
}

MANIFEST="$OVERLAY_DIR/manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  WARNINGS+=("overlay が未導入: $MANIFEST が無い。組織固有の QC 観点は適用されない")
  emit 0 0 "" 0 ""
fi

FLAT="$(tr -d '\n' < "$MANIFEST" 2>/dev/null)"
if [[ -z "$FLAT" ]]; then
  WARNINGS+=("manifest.json が空か読めない: $MANIFEST")
  emit 0 0 "" 0 ""
fi

REVIEWER_AGENT="$(extract_string "$FLAT" "reviewer_agent")"
if [[ -z "$REVIEWER_AGENT" ]]; then
  WARNINGS+=("manifest.json に reviewer_agent が無い。dev-qa は QC レンズ無しの3並列になる")
elif [[ "$REVIEWER_AGENT" != *:* ]]; then
  # 接頭辞なしの agent 名は ~/.claude/agents/ の同名コピーに解決される（Issue #25）。
  WARNINGS+=("reviewer_agent が <plugin>:<agent> 形式でない: $REVIEWER_AGENT。名前解決に失敗する")
  REVIEWER_AGENT=""
fi

# ファイル名は <フェーズ名>.md 固定。manifest で差し替えられるようにすると、判定器は
# 差し替え先を見るのに agent 側はハードコードした <phase>.md を見るため、判定器が
# applied=1 を返しているのに agent は「未適用」と報告する状態が作れてしまう。
# $PHASE は冒頭で allowlist 照合済みなので、ここでパス区切りが混入する経路は無い。
TARGET="$OVERLAY_DIR/$PHASE.md"

if [[ ! -f "$TARGET" ]]; then
  WARNINGS+=("overlay はあるが $PHASE のファイルが無い: $TARGET。このフェーズの観点は適用されない")
  emit 1 0 "" 0 "$REVIEWER_AGENT"
fi

ITEMS="$(count_items "$TARGET")"
[[ "$ITEMS" =~ ^[0-9]+$ ]] || ITEMS=0

if [[ "$ITEMS" -eq 0 ]]; then
  WARNINGS+=("$PHASE のファイルに観点が0件: $TARGET。雛形のまま中身が埋められていない可能性がある")
  emit 1 0 "" 0 "$REVIEWER_AGENT"
fi

emit 1 1 "$TARGET" "$ITEMS" "$REVIEWER_AGENT"
