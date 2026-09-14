#!/usr/bin/env bash
# secret-scan.sh
#
# 現在の git リポジトリで、未 push 範囲の diff にシークレット候補が混入していないか走査する。
# 検出ゼロ → exit 0（push 続行）
# 検出あり → 該当箇所を stderr に出力 → exit 1（push ブロック）
#
# 呼び出し元: hooks/pre-bash-push-check.sh
# 独立実行も可能（デバッグ用途）。

set -uo pipefail

# ---- スキャン範囲の決定 ----
# 1. @{push}..HEAD（remote tracking の push 先がある場合、最も正確）
# 2. @{upstream}..HEAD（upstream はあるが push 先未設定）
# 3. HEAD（新規ブランチ、リモート未設定）
range=""
if git rev-parse @{push} >/dev/null 2>&1; then
  range="@{push}..HEAD"
elif git rev-parse '@{upstream}' >/dev/null 2>&1; then
  range='@{upstream}..HEAD'
else
  range="HEAD"
fi

# ---- diff 取得 ----
TMP=$(mktemp /tmp/secret-scan-XXXXXX) || exit 0
trap "rm -f $TMP /tmp/secret-scan-*-vio.txt 2>/dev/null" EXIT

if [ "$range" = "HEAD" ]; then
  # upstream 未設定 = 新規ブランチ。直近の1コミットだけ見る（過剰スキャン回避）。
  # 本物の push 時には origin/<branch> が出来た後 @{upstream} が解決するので、
  # この経路は主に「リモートに紐付けてない一時ブランチ」用。
  git log --no-color -p --max-count=1 > "$TMP" 2>/dev/null || true
else
  git diff --no-color "$range" > "$TMP" 2>/dev/null || true
fi

if [ ! -s "$TMP" ]; then
  echo "[git-secret-guard] スキャン対象の差分なし（range=$range）" >&2
  exit 0
fi

# ---- 検出パターン ----
VIO_PREFIX=/tmp/secret-scan-prefix-vio.txt
VIO_VARS=/tmp/secret-scan-vars-vio.txt
VIO_LONG=/tmp/secret-scan-long-vio.txt
: > "$VIO_PREFIX"
: > "$VIO_VARS"
: > "$VIO_LONG"

# 1. 既知 SaaS / Cloud のトークン prefix（追加行 "+" に限定。削除行は問題ない）
grep -nE \
  '^\+.*(sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|xox[abps]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z]+ PRIVATE KEY-----)' \
  "$TMP" > "$VIO_PREFIX" 2>/dev/null || true

# 2. 変数代入で値が長い & 既知のホワイトリスト用語を含まない
# 追加された行（"+" で始まる）に限定して誤検出を減らす
grep -nE \
  '^\+.*(PASSWORD|PASSWD|SECRET|API[_-]?KEY|API[_-]?TOKEN|TOKEN|BEARER)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9!#$%&*+/=?_~@.-]{8,}' \
  "$TMP" 2>/dev/null \
  | grep -vE 'os\.environ|_require_env|process\.env|<[^>]+>|your-|replace-with|example\.|placeholder|fake|\$\{|\$[A-Z_]+|description.*password|name="password"|\*{2,}|REDACTED|XXXX|0000+' \
  > "$VIO_VARS" 2>/dev/null || true

# 3. 長い英数字（40文字以上）の塊。URL や SHA 行は除外
grep -nE '^\+.*[A-Za-z0-9]{40,}' "$TMP" 2>/dev/null \
  | grep -vE 'https?://|sha:|"sha"|@sha256|commit |bytes|base64|<svg|hash:|\*{2,}|REDACTED' \
  | head -50 > "$VIO_LONG" 2>/dev/null || true

# ---- 集計 ----
COUNT_PREFIX=$(wc -l < "$VIO_PREFIX")
COUNT_VARS=$(wc -l < "$VIO_VARS")
COUNT_LONG=$(wc -l < "$VIO_LONG")
TOTAL=$((COUNT_PREFIX + COUNT_VARS + COUNT_LONG))

if [ "$TOTAL" -eq 0 ]; then
  echo "[git-secret-guard] ✓ シークレット混入なし（range=$range）" >&2
  exit 0
fi

# ---- 検出時の出力 ----
{
  echo ""
  echo "❌ git-secret-guard: 潜在的シークレットを検出しました（range=$range）"
  echo ""
  if [ "$COUNT_PREFIX" -gt 0 ]; then
    echo "【 SaaS/Cloud トークン形式 】$COUNT_PREFIX 件"
    head -10 "$VIO_PREFIX" | sed 's/^/    /'
    echo ""
  fi
  if [ "$COUNT_VARS" -gt 0 ]; then
    echo "【 PASSWORD/API_TOKEN 等の変数代入 】$COUNT_VARS 件"
    head -10 "$VIO_VARS" | sed 's/^/    /'
    echo ""
  fi
  if [ "$COUNT_LONG" -gt 0 ]; then
    echo "【 40文字以上の長い英数字 】$COUNT_LONG 件（誤検出多め、要目視）"
    head -5 "$VIO_LONG" | sed 's/^/    /'
    echo ""
  fi
  echo "git push を中止しました。"
  echo ""
  echo "対処:"
  echo "  1. 該当の値を ~/.cc-plugins/.env に移動して、コードからは os.environ.get() 等で読む"
  echo "  2. 誤検出と確信できる場合は ALLOW_SECRETS=1 を環境変数に設定してから再 push"
  echo "  3. プレースホルダ用の文字列なら <...>, your-..., replace-with-... 等の表記に変える"
} >&2

exit 1
