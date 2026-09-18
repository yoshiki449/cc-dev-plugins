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
TMP_NONTEST=$(mktemp /tmp/secret-scan-nontest-XXXXXX) || exit 0
VIO_PREFIX=$(mktemp /tmp/secret-scan-prefix-vio-XXXXXX) || exit 0
VIO_VARS=$(mktemp /tmp/secret-scan-vars-vio-XXXXXX) || exit 0
VIO_LONG=$(mktemp /tmp/secret-scan-long-vio-XXXXXX) || exit 0
# クリーンアップはすべて実パスの変数参照で行う（glob 頼みにしない）。
# glob（/tmp/secret-scan-nontest-*）で消すと、同時に走っている別プロセスの
# 未使用でも生存中のファイルまで巻き込んで消しうる（コードレビューで指摘）。
trap "rm -f $TMP $FILES_LIST $TMP_NONTEST $VIO_PREFIX $VIO_VARS $VIO_LONG 2>/dev/null" EXIT


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
VALUE_CHARS='[A-Za-z0-9!#$%&*+/=?_~@.-]{8,}'
DETECT2='^\+.*'"$KW"'[[:space:]]*[=:][[:space:]]*["'"'"']?'"$VALUE_CHARS"

# 除外語は「代入された値そのもの」に対してだけ判定する（行全体に対してでは
# ない）。敵対的レビューで実測: 行全体を対象にすると、値とは無関係な場所
# （同じ行の末尾コメント等）に除外語を1つ混ぜるだけで本物らしい値まで
# 検出をすり抜けられる。
#
# それでも防げないケースがもう1つあった: 除外語が値そのものの中に
# **部分文字列として埋め込まれている**場合（例: `API_TOKEN =
# "notFakeRealSecretXYZ9"`。値を切り出しても "fake" を含んでいる）。
# プレースホルダを示す英単語（fake/dummy/sample 等）は、前後が英字で
# 挟まれていない位置でのみ一致させる（HASHICORP_TOKEN を誤って除外しない
# ようにした "hash" の境界条件と同じ考え方）。"notFakeReal..." の
# "Fake" は前後とも英字に挟まれているため、この境界条件では一致しない
# （除外されない＝本物の値なら引き続き検出される）。
# "xxxx" は同じ理由で厳密な単語一致ではなく4文字以上の繰り返しとして
# 判定する（"XXXXXXXX" のような値は先頭の4文字の直後も英字が続くため、
# 単語境界条件だと一致しなくなってしまう）。
PLACEHOLDER_WORDS='(fake|dummy|sample|placeholder|redacted|change-?me|your-|replace-with|example\.)'
VALUE_EXCLUDE='os\.environ|_require_env|process\.env|<[^>]+>|(^|[^A-Za-z])'"$PLACEHOLDER_WORDS"'([^A-Za-z]|$)|\$\{|\$[A-Za-z_]+|\*{2,}|x{4,}|0000+|\$2[aby]\$|argon2|pbkdf2|scrypt'
# HTML/JSON の周辺マークアップ判定は値の中身ではなく行全体の構造を見る
# ものなので、こちらは従来どおり行全体に対して判定する。
LINE_EXCLUDE='description.*password|name="password"'

while IFS= read -r cand; do
  content="${cand#*:}"
  if printf '%s\n' "$content" | grep -qiE "$LINE_EXCLUDE"; then
    continue
  fi
  if printf '%s\n' "$content" | grep -qiE "$HASH_ADJ"; then
    continue
  fi
  value=$(printf '%s\n' "$content" \
    | grep -oE "$KW"'[[:space:]]*[=:][[:space:]]*["'"'"']?'"$VALUE_CHARS" \
    | sed -E 's/^'"$KW"'[[:space:]]*[=:][[:space:]]*["'"'"']?//')
  if printf '%s\n' "$value" | grep -qiE "$VALUE_EXCLUDE"; then
    continue
  fi
  printf '%s\n' "$cand"
done < <(grep -nE "$DETECT2" "$TMP_NONTEST" 2>/dev/null) > "$VIO_VARS"

# 3. 長い英数字（40文字以上）の塊。URL や SHA 行、ハッシュ値は除外
# "hash" は前後が英字でない位置（行頭/行末 or 非英字）でのみ一致させる。
# `\b`（単語境界）は使えない: アンダースコアは word 文字として扱われるため
# "PASSWORD_HASH" の "_HASH" 側で境界が成立せず、除外したいケースを取りこぼす。
# 一方 "HASHICORP_TOKEN" の "HASH" は右側が英字 "I" で続くので、この境界条件
# では一致しない（除外されない＝本物の値なら引き続き検出される）。
#
# `sha(1|256|384|512)-` は npm/yarn の SRI（Subresource Integrity）形式の値そのもの
# （例: package-lock.json の "integrity": "sha512-....=="）に必ず付く接頭辞。
# "integrity" という語をキーと同じ行に要求する既存の除外だけでは、キーと値が
# 別行に分かれた JSON（`"integrity":\n  "sha512-...=="`）で "integrity" が
# 値の行に無くなり誤検出していた（実測）。値そのものの形（sha512- 接頭辞）を
# 直接見れば、キーが同じ行にあるかどうかに依存しない。
grep -nE '^\+.*[A-Za-z0-9]{40,}' "$TMP_NONTEST" 2>/dev/null \
  | grep -viE 'https?://|sha:|"sha"|@sha256|commit |bytes|base64|<svg|(^|[^A-Za-z])hash([^A-Za-z]|$)|\*{2,}|redacted|integrity|checksum|sha(1|256|384|512)-' \
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
