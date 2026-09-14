#!/usr/bin/env bash
# 用途: .agent/STATE.md の Run Log を集計し、直近 N 日のループ運用メトリクスを Markdown で標準出力する。
#       supervisor の誤 halt 率（halt=過剰 の割合）も算出し、30% 超なら警告を出す。
# 使い方: bash loop-metrics.sh [プロジェクトルート] [日数]
#   引数省略時: プロジェクトルート = git rev-parse --show-toplevel（失敗時 $PWD）、日数 = 7
# 出力: Markdown（STATE.md が無い/Run Log が空なら「データなし」の1セクション）。exit 0。
set -euo pipefail

PROJECT_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"
DAYS="${2:-7}"
STATE_MD="$PROJECT_ROOT/.agent/STATE.md"
CUTOFF="$(date -d "-${DAYS} days" +%Y-%m-%d 2>/dev/null || date -v -"${DAYS}"d +%Y-%m-%d)"

echo "## ループ運用メトリクス（直近 ${DAYS} 日: ${CUTOFF} 以降）"
echo ""

if [ ! -f "$STATE_MD" ]; then
  echo "データなし（\`.agent/STATE.md\` が存在しません。\`ensure-loop-files.sh\` で生成できます）"
  exit 0
fi

awk -F'|' -v cutoff="$CUTOFF" '
  # Run Log のデータ行のみ対象: "| YYYY-MM-DD ..." で始まる行
  /^\| *20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ {
    date = trim($2); loop = trim($3); mode = trim($4)
    commits = trim($6); tokens = trim($7); status = trim($8); notes = trim($9)
    if (substr(date, 1, 10) < cutoff) next
    runs++
    by_loop[loop]++
    by_status[status]++
    if (status ~ /^halted-/) halted++
    if (commits ~ /^[0-9]+$/) total_commits += commits
    if (tokens ~ /^[0-9]+$/) total_tokens += tokens
    if (status == "halted-supervisor" || status == "halted-checkpoint") {
      sup_halts++
      if (notes ~ /halt=妥当/) sup_valid++
      else if (notes ~ /halt=過剰/) sup_over++
    }
  }
  function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
  END {
    if (runs == 0) { print "データなし（期間内の Run Log がありません）"; exit }
    printf "- **runs**: %d（halted 率: %d%%）\n", runs, int(halted * 100 / runs)
    printf "- **累積 commits**: %d ／ **累積 token 概算**: %s\n", total_commits, (total_tokens > 0 ? total_tokens "" : "記録なし")
    print ""
    print "### loop 別 run 数"
    for (l in by_loop) printf "- %s: %d\n", l, by_loop[l]
    print ""
    print "### final_status 内訳"
    for (s in by_status) printf "- %s: %d\n", s, by_status[s]
    print ""
    print "### supervisor 精度（halted-supervisor / halted-checkpoint）"
    if (sup_halts == 0) {
      print "- supervisor 起因の halt なし"
    } else {
      labeled = sup_valid + sup_over
      printf "- halt 件数: %d（妥当: %d ／ 過剰: %d ／ 未ラベル: %d）\n", sup_halts, sup_valid, sup_over, sup_halts - labeled
      if (labeled > 0) {
        rate = int(sup_over * 100 / labeled)
        printf "- **誤 halt 率: %d%%**\n", rate
        if (rate > 30) print "- ⚠ **警告: 誤 halt 率が 30% を超えています。LOOP.md の見直し基準に該当 — loop-supervisor のプロンプト調整を検討してください**"
      }
    }
  }
' "$STATE_MD"

# 補足: STATE.md 外の run 痕跡（期間内に更新されたループ関連ファイル）を参考情報として列挙
recent_artifacts=$(find "$PROJECT_ROOT/.agent" -maxdepth 2 \
  \( -name 'devloop-*.md' -o -name 'triage-*.md' -o -path '*/autopilot/*/state.md' \) \
  -mtime -"$DAYS" 2>/dev/null | sort || true)
if [ -n "$recent_artifacts" ]; then
  echo ""
  echo "### 期間内のループ関連ファイル（参考）"
  echo "$recent_artifacts" | while IFS= read -r f; do
    echo "- ${f#"$PROJECT_ROOT"/}"
  done
fi
