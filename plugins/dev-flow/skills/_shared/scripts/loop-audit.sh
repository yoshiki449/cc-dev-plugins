#!/usr/bin/env bash
# 用途: ループ運用の readiness スコア（0-100）を機械チェックで算出する。
#       loop-engineering の loop-audit 相当。ファイル存在だけでなく
#       「実際に動いた証拠（proven activity）」と「halt ラベリング運用」も見る。
#       最終的な L1/L2/L3 昇格判定は /loop-review スキル側の Claude が
#       Debrief・価値指標と合成して行う。本スクリプトは材料提供に徹する。
# 使い方: bash loop-audit.sh [プロジェクトルート] [日数]
#   引数省略時: プロジェクトルート = git rev-parse --show-toplevel（失敗時 $PWD）、日数 = 28
# 出力: Markdown（シグナル別 OK/NG 表＋合計スコア＋レベル目安）。exit 0。
set -euo pipefail

PROJECT_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"
DAYS="${2:-28}"
AGENT_DIR="$PROJECT_ROOT/.agent"
STATE_MD="$AGENT_DIR/STATE.md"
LOOP_MD="$AGENT_DIR/LOOP.md"
DENYLIST="$AGENT_DIR/loop-denylist.txt"
CUTOFF="$(date -d "-${DAYS} days" +%Y-%m-%d 2>/dev/null || date -v -"${DAYS}"d +%Y-%m-%d)"

score=0
rows=""

add_row() { # add_row <シグナル名> <得点> <満点> <詳細>
  score=$((score + $2))
  rows="${rows}| $1 | $2/$3 | $4 |
"
}

# ── S1: STATE.md 存在＋Run Log にデータ行（15）──
runlog_rows=0
if [ -f "$STATE_MD" ]; then
  runlog_rows=$(grep -cE '^\| *20[0-9]{2}-[0-9]{2}-[0-9]{2}' "$STATE_MD" || true)
fi
if [ ! -f "$STATE_MD" ]; then
  add_row "STATE.md（Run Log 実績）" 0 15 "ファイルなし"
elif [ "$runlog_rows" -eq 0 ]; then
  add_row "STATE.md（Run Log 実績）" 7 15 "ファイルはあるが Run Log が空"
else
  add_row "STATE.md（Run Log 実績）" 15 15 "Run Log ${runlog_rows} 行"
fi

# ── S2: LOOP.md 存在＋予算セクション（15）──
if [ ! -f "$LOOP_MD" ]; then
  add_row "LOOP.md（予算宣言）" 0 15 "ファイルなし"
elif grep -qE '^- *max_(iterations|commits|attempts):' "$LOOP_MD"; then
  add_row "LOOP.md（予算宣言）" 15 15 "予算キーあり"
else
  add_row "LOOP.md（予算宣言）" 7 15 "ファイルはあるが予算キーなし"
fi

# ── S3: loop-denylist.txt 存在（10）──
if [ -f "$DENYLIST" ]; then
  add_row "denylist" 10 10 "あり"
else
  add_row "denylist" 0 10 "なし"
fi

# ── S4-S6: Run Log の期間内解析（awk 一括: activity / halt ラベリング / 誤 halt 率）──
recent_runs=0; sup_halts=0; sup_labeled=0; sup_over=0
if [ -f "$STATE_MD" ]; then
  read -r recent_runs sup_halts sup_labeled sup_over < <(awk -F'|' -v cutoff="$CUTOFF" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^\| *20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ {
      date = trim($2); status = trim($8); notes = trim($9)
      if (substr(date, 1, 10) < cutoff) next
      runs++
      if (status == "halted-supervisor" || status == "halted-checkpoint") {
        halts++
        if (notes ~ /halt=(妥当|過剰)/) labeled++
        if (notes ~ /halt=過剰/) over++
      }
    }
    END { printf "%d %d %d %d\n", runs, halts, labeled, over }
  ' "$STATE_MD") || true
fi

# S4: proven activity（期間内に run がある）（15）
if [ "$recent_runs" -gt 0 ]; then
  add_row "proven activity（直近${DAYS}日）" 15 15 "${recent_runs} run"
else
  add_row "proven activity（直近${DAYS}日）" 0 15 "期間内の run なし"
fi

# S5: halt ラベリング運用（10）— halt 0件なら運用課題なしで満点
if [ "$sup_halts" -eq 0 ]; then
  add_row "halt ラベリング運用" 10 10 "supervisor halt なし"
elif [ "$sup_labeled" -eq "$sup_halts" ]; then
  add_row "halt ラベリング運用" 10 10 "全 ${sup_halts} 件ラベル済み"
elif [ "$sup_labeled" -gt 0 ]; then
  add_row "halt ラベリング運用" 5 10 "${sup_labeled}/${sup_halts} 件のみラベル済み"
else
  add_row "halt ラベリング運用" 0 10 "ラベルなし（${sup_halts} 件未評価）"
fi

# S6: 誤 halt 率 ≤30%（10）— halt 0件は満点、未ラベルは計測不能で 0
misrate="-"
if [ "$sup_halts" -eq 0 ]; then
  add_row "誤 halt 率" 10 10 "halt なし（問題なし）"
elif [ "$sup_labeled" -eq 0 ]; then
  add_row "誤 halt 率" 0 10 "計測不能（ラベルなし）"
else
  misrate=$((sup_over * 100 / sup_labeled))
  if [ "$misrate" -le 30 ]; then
    add_row "誤 halt 率" 10 10 "${misrate}%（≤30%）"
  else
    add_row "誤 halt 率" 0 10 "${misrate}%（>30%、要見直し）"
  fi
fi

# ── S7: triage レポートの実績（期間内 triage-*.md）（10）──
triage_count=$( (find "$AGENT_DIR" -maxdepth 1 -name 'triage-*.md' -mtime -"$DAYS" 2>/dev/null || true) | wc -l)
if [ "$triage_count" -gt 0 ]; then
  add_row "triage 実績（直近${DAYS}日）" 10 10 "${triage_count} 件"
else
  add_row "triage 実績（直近${DAYS}日）" 0 10 "なし"
fi

# ── S8: Open Items の管理（7日超滞留が 3 件以下）（10）──
stale_cutoff="$(date -d "-7 days" +%Y-%m-%d 2>/dev/null || date -v -7d +%Y-%m-%d)"
stale_items=0
if [ -f "$STATE_MD" ]; then
  stale_items=$(awk -v cutoff="$stale_cutoff" '
    /^## Open Items/ { in_sec = 1; next }
    /^## / { in_sec = 0 }
    in_sec && /^- \[20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]\]/ {
      d = substr($0, 4, 10)
      if (d < cutoff) stale++
    }
    END { print stale + 0 }
  ' "$STATE_MD")
fi
if [ "$stale_items" -le 3 ]; then
  add_row "Open Items 管理" 10 10 "7日超滞留 ${stale_items} 件（≤3）"
else
  add_row "Open Items 管理" 0 10 "7日超滞留 ${stale_items} 件（>3、prune 要）"
fi

# ── S9: Run Log の肥大化管理（50行以下 or アーカイブ運用）（5）──
if [ "$runlog_rows" -le 50 ] || [ -d "$AGENT_DIR/state-archive" ]; then
  add_row "Run Log 肥大化管理" 5 5 "OK（${runlog_rows} 行）"
else
  add_row "Run Log 肥大化管理" 0 5 "${runlog_rows} 行（>50、アーカイブ推奨）"
fi

# ── 出力 ──
echo "## Loop readiness スコア（機械チェック、直近 ${DAYS} 日: ${CUTOFF} 以降）"
echo ""
echo "| シグナル | 得点 | 詳細 |"
echo "|---|---|---|"
printf '%s' "$rows"
echo ""
echo "**合計: ${score}/100**"
echo ""
echo "### レベル目安（最終判定は /loop-review が Debrief・価値指標と合成して行う）"
l1="✗"; l2="✗"; l3="✗"
[ "$score" -ge 40 ] && l1="✓"
[ "$score" -ge 60 ] && [ "$recent_runs" -gt 0 ] && { [ "$sup_halts" -eq 0 ] || [ "$sup_labeled" -gt 0 ]; } && l2="✓"
if [ "$score" -ge 80 ] && [ "$recent_runs" -gt 0 ]; then
  if [ "$sup_halts" -eq 0 ]; then
    l3="✓"
  elif [ "$sup_labeled" -gt 0 ] && [ "$misrate" != "-" ] && [ "$misrate" -le 30 ]; then
    l3="✓"
  fi
fi
echo "- L1-ready（score ≥ 40）: $l1"
echo "- L2-ready（score ≥ 60 ＋ activity ＋ ラベリング運用）: $l2"
echo "- L3-ready（score ≥ 80 ＋ 誤 halt 率計測済み ≤30%）: $l3"
