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
VIO_PREFIX=$(mktemp /tmp/secret-scan-prefix-vio-XXXXXX) || exit 0
VIO_VARS=$(mktemp /tmp/secret-scan-vars-vio-XXXXXX) || exit 0
VIO_LONG=$(mktemp /tmp/secret-scan-long-vio-XXXXXX) || exit 0
trap "rm -f $TMP /tmp/secret-scan-nontest-* $VIO_PREFIX $VIO_VARS $VIO_LONG 2>/dev/null" EXIT

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

# ---- テスト/フィクスチャファイルの除外対象（パターン2・3のみ） ----
# パターン1（既知トークンprefix）は本物の値が紛れ込むリスクが形で分かるので
# テストファイルであっても引き続き全文を見る。パターン2・3は「値の形」だけで
# 判定するため、テスト用のダミー値・フィクスチャで誤検出しやすい。
# diff のファイルヘッダ（--- a/<path> の直後の +++ b/<path>）を追いながら、
# 現在のファイルがテスト/フィクスチャらしいときだけそのファイルの追加行を落とす。
#
# "--- " の直後という条件が必須（コードレビューで実測したバイパス経路）:
# unified diff の "+++ " ヘッダは本文中には出ない前提で、当初は単に "+++ " で
# 始まる行が来たらヘッダとして扱っていた。しかし「追加された行の中身がたまたま
# "++ " から始まる」場合、diff 上の見た目は "+" (追加行マーカー) + "++ 本文" =
# "+++ 本文" になり、区別が付かなくなる。この行を偽ヘッダとして誤認すると、
# 以降の追加行（本物のシークレットを含みうる）が丸ごとテスト扱いになって
# 検出から漏れる。本物のヘッダは常に "--- a/<path>" の直後にしか現れないので、
# 直前行が "--- " だったときだけ次の "+++ " をヘッダとして受理する。
TMP_NONTEST=$(mktemp /tmp/secret-scan-nontest-XXXXXX) || exit 0
awk '
  {
    if ($0 ~ /^--- /) { pending_header = 1; next }
    if (pending_header && $0 ~ /^\+\+\+ /) {
      file = $0
      sub(/^\+\+\+ [ab]\//, "", file)
      lf = tolower(file)
      istest = (lf ~ /(^|\/)(tests?|specs?|__tests__|__mocks__|mocks?|fixtures?|__fixtures__|testdata)(\/|$)/) \
            || (lf ~ /\.(test|spec)\.[^.\/]*$/) \
            || (lf ~ /(_test|_spec)\.[^.\/]*$/)
      pending_header = 0
      next
    }
    pending_header = 0
    if ($0 ~ /^\+/) { if (!istest) print }
  }
' "$TMP" > "$TMP_NONTEST" 2>/dev/null || true

# ---- 検出パターン ----
# 1. 既知 SaaS / Cloud のトークン prefix（追加行 "+" に限定。削除行は問題ない）
# テスト/フィクスチャファイルでも見る。本物の値が紛れ込む害の方が大きい。
grep -nE \
  '^\+.*(sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|xox[abps]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z]+ PRIVATE KEY-----)' \
  "$TMP" > "$VIO_PREFIX" 2>/dev/null || true

# 2. 変数代入で値が長い & 既知のホワイトリスト用語を含まない
# 追加された行（"+" で始まる）に限定して誤検出を減らす。
# 除外側は大文字小文字を区別しない（-i）: "Fake" "REPLACE-WITH" のような
# 表記違いを、小文字パターンだけで書いていたせいで誤検出していた。
# ハッシュ化済みの値（bcrypt/argon2/pbkdf2/scrypt の形）はそもそも秘密の値
# そのものではないので除外する。"hash" を含む変数名（PASSWORD_HASH 等）も
# 同様に除外するが、行のどこかに "hash" があれば無条件に除外、ではなく
# 検出対象のキーワードと直接隣接する複合語（間はアンダースコア1個まで）に
# 限る（セルフレビューで実測: 素の "hash" 単語一致だと、無関係な変数名や
# 値・コメントに "hash" を含むだけの本物の値まで除外してしまう。
# `[A-Za-z0-9_]*` のような無制限のギャップにすると、逆に HASHICORP_TOKEN の
# ような無関係な識別子まで「hash と TOKEN が同じ行にある」というだけで
# 除外してしまう。ギャップは "_?"（アンダースコア1個まで）に絞る）。
GAP='_?'
KW='(PASSWORD|PASSWD|SECRET|API[_-]?KEY|API[_-]?TOKEN|TOKEN|BEARER)'
HASH_ADJ="(hash${GAP}${KW}|${KW}${GAP}hash)"'[[:space:]]*[=:]'
grep -nE \
  '^\+.*'"$KW"'[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9!#$%&*+/=?_~@.-]{8,}' \
  "$TMP_NONTEST" 2>/dev/null \
  | grep -viE 'os\.environ|_require_env|process\.env|<[^>]+>|your-|replace-with|example\.|placeholder|fake|dummy|sample|change-?me|\$\{|\$[A-Za-z_]+|description.*password|name="password"|\*{2,}|redacted|xxxx|0000+|\$2[aby]\$|argon2|pbkdf2|scrypt|'"$HASH_ADJ" \
  > "$VIO_VARS" 2>/dev/null || true

# 3. 長い英数字（40文字以上）の塊。URL や SHA 行、ハッシュ値は除外
# "hash" は前後が英字でない位置（行頭/行末 or 非英字）でのみ一致させる。
# `\b`（単語境界）は使えない: アンダースコアは word 文字として扱われるため
# "PASSWORD_HASH" の "_HASH" 側で境界が成立せず、除外したいケースを取りこぼす。
# 一方 "HASHICORP_TOKEN" の "HASH" は右側が英字 "I" で続くので、この境界条件
# では一致しない（除外されない＝本物の値なら引き続き検出される）。
grep -nE '^\+.*[A-Za-z0-9]{40,}' "$TMP_NONTEST" 2>/dev/null \
  | grep -viE 'https?://|sha:|"sha"|@sha256|commit |bytes|base64|<svg|(^|[^A-Za-z])hash([^A-Za-z]|$)|\*{2,}|redacted|integrity|checksum' \
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
