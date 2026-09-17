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
FILES_LIST=$(mktemp /tmp/secret-scan-files-XXXXXX) || exit 0
VIO_PREFIX=$(mktemp /tmp/secret-scan-prefix-vio-XXXXXX) || exit 0
VIO_VARS=$(mktemp /tmp/secret-scan-vars-vio-XXXXXX) || exit 0
VIO_LONG=$(mktemp /tmp/secret-scan-long-vio-XXXXXX) || exit 0
trap "rm -f $TMP /tmp/secret-scan-nontest-* $FILES_LIST $VIO_PREFIX $VIO_VARS $VIO_LONG 2>/dev/null" EXIT


# NUL区切り→1行1レコードへの変換に使う awk 断片。
# ファイル名には NUL は入りえない（ファイルシステムの制約）が、**改行は
# POSIX 上許可されている**。単純に `tr '\0' '\n'` で変換すると、改行を
# 含むファイル名がその場でレコード境界として割れてしまい、以降すべての
# ファイルの対応関係がずれる（セキュリティレビューで実機再現）。
# バックスラッシュ→\\、改行→\n の順でエスケープしてから1行として書き出す
# ことで、レコードの境界を実際の改行（レコード内には現れない）だけに保つ。
# 判定（tests/ 等の部分文字列一致）はエスケープ後の文字列に対して行っても
# 結果は変わらない（エスケープはバックスラッシュと改行だけに作用し、
# スラッシュや英数字は素通しするため）。
Z_TO_LINES='BEGIN{RS="\0"; ORS="\n"} { gsub(/\\/,"\\\\"); gsub(/\n/,"\\n"); print }'

if [ "$range" = "HEAD" ]; then
  # upstream 未設定 = 新規ブランチ。直近の1コミットだけ見る（過剰スキャン回避）。
  # 本物の push 時には origin/<branch> が出来た後 @{upstream} が解決するので、
  # この経路は主に「リモートに紐付けてない一時ブランチ」用。
  git log --no-color -p --max-count=1 > "$TMP" 2>/dev/null || true
  git log -z --name-only --format= --max-count=1 2>/dev/null | awk "$Z_TO_LINES" > "$FILES_LIST" || true
else
  git diff --no-color "$range" > "$TMP" 2>/dev/null || true
  git diff -z --name-only "$range" 2>/dev/null | awk "$Z_TO_LINES" > "$FILES_LIST" || true
fi

if [ ! -s "$TMP" ]; then
  echo "[git-secret-guard] スキャン対象の差分なし（range=$range）" >&2
  exit 0
fi

# ---- テスト/フィクスチャファイルの除外対象（パターン2・3のみ） ----
# パターン1（既知トークンprefix）は本物の値が紛れ込むリスクが形で分かるので
# テストファイルであっても引き続き全文を見る。パターン2・3は「値の形」だけで
# 判定するため、テスト用のダミー値・フィクスチャで誤検出しやすい。
#
# ファイルパスは diff 本文の "diff --git a/<path> b/<path>" 行から正規表現で
# 抜き出すのではなく、別途取得した $FILES_LIST（`git diff -z --name-only` /
# `git log -z --name-only`。-z はクォートを一切行わず生のパスを NUL 区切りで返す）
# と、diff 本文中の "diff --git " 行の**出現順**を突き合わせて決める
# （両方とも同じ diff 生成過程から来るので順序は一致する）。
#
# "diff --git a/X b/Y" の1行から X と Y をテキストとして正規表現で
# 切り出す方式は、5回のセキュリティレビューで作っては塞ぐを繰り返した末に
# 断念した: ファイル名が任意の文字（スペース・スラッシュ・非ASCII等）を
# 許す以上、区切りを表す " b/" 自体がファイル名の一部として現れうるため、
# パースの成功/失敗を行の見た目だけから正しく判定する方法が原理的に無い。
# （経緯: (1) "+++ " 単体をヘッダ扱い→追加行の中身が "++ " から始まると誤認。
# (2) 直前行が "--- " の場合のみ受理→偽の削除行(--)+偽の追加行(++)の組で
# 回避可能。(3) "diff --git " 行へアンカーを変更→リネーム時に旧パス（a/側）を
# 使ってしまうバグ。(4) 新パス（b/側）に直しても、非ASCII文字で git が
# クォートすると抽出が空振りし、"パース失敗をどう検知するか" が別の抜け穴に。
# (5) パース失敗の検知自体も、ファイル名に " b/" のような区切りに見える
# 文字列を仕込まれると、貪欲マッチが意図しない位置に「成功」してしまい
# 検知をすり抜けた。）
# パースに一切頼らず、信頼できる別ソースから来た一覧を順番で引き当てる
# ことで、この種のバイパスをクラスごと閉じる。
TMP_NONTEST=$(mktemp /tmp/secret-scan-nontest-XXXXXX) || exit 0
awk '
  FNR==NR { files[FNR] = $0; next }
  {
    if ($0 ~ /^diff --git /) {
      file_idx++
      if (!(file_idx in files)) {
        # 出現順が $FILES_LIST の件数を超えた（想定外の食い違い）。
        # 対応関係に自信が持てないので安全側（走査する＝除外しない）に倒す。
        istest = 0
        next
      }
      file = files[file_idx]
      lf = tolower(file)
      istest = (lf ~ /(^|\/)(tests?|specs?|__tests__|__mocks__|mocks?|fixtures?|__fixtures__|testdata)(\/|$)/) \
            || (lf ~ /\.(test|spec)\.[^.\/]*$/) \
            || (lf ~ /(_test|_spec)\.[^.\/]*$/)
      next
    }
    if ($0 ~ /^\+/) { if (!istest) print }
  }
' "$FILES_LIST" "$TMP" > "$TMP_NONTEST" 2>/dev/null || true

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
