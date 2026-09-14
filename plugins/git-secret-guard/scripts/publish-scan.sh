#!/usr/bin/env bash
# publish-scan.sh
#
# 公開リポジトリに組織固有の語が混入していないか走査する。
# secret-scan.sh が「秘密の値」を見るのに対し、こちらは「外に出してはいけない固有名」を見る。
#
# 検出ゼロ → exit 0
# 検出あり → 該当箇所を stderr に出して exit 1
#
# 呼び出し元: hooks/pre-bash-push-check.sh（git push 直前）、および手動（公開前の一括確認）。
#
# ---------------------------------------------------------------------------
# なぜ denylist をリポジトリ内に置かないか
#
# denylist には顧客名・社内システム名・人名が並ぶ。これをそのまま公開リポジトリに
# 置くと「何を隠したいかの一覧」が公開される。だから ~/.cc-plugins/publish-denylist.txt
# （リポジトリ外・ユーザー個別）に置き、スクリプト本体は汎用パターンだけを持つ。
#
# なぜ全リポジトリで無条件に走らせないか
#
# 私有リポジトリでは組織固有の語が出てくるのが正常で、そこでブロックしたら使えない。
# 対象は denylist の [public-repos] に書いた remote だけ。判定の権限を1つの私有ファイルに
# 集約しているので、公開リポジトリ側のファイルを消しても無効化できない。
# ---------------------------------------------------------------------------
#
# 使い方:
#   bash publish-scan.sh                    # 未 push 範囲の diff を走査（hook 経路）
#   bash publish-scan.sh --paths <path>...  # 指定パス配下の全ファイルを走査（公開前の一括確認）
#   bash publish-scan.sh --all              # リポジトリの tracked 全ファイルを走査
#   bash publish-scan.sh --force            # [public-repos] 照合を飛ばして必ず走査する
#
# 終了コード:
#   0: 検出なし、または対象リポジトリでない（no-op）
#   1: 検出あり
#   2: 引数エラー・denylist が壊れている

set -u

DENYLIST="${CC_PUBLISH_DENYLIST:-$HOME/.cc-plugins/publish-denylist.txt}"
MODE=diff
FORCE=0
PATHS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --paths) MODE=paths; shift; while [[ $# -gt 0 && "$1" != --* ]]; do PATHS+=("$1"); shift; done ;;
    --all) MODE=all; shift ;;
    --force) FORCE=1; shift ;;
    --help|-h)
      sed -n '/^# 使い方:/,/^#   2:/p' "$0" | sed 's/^# \{0,1\}//' >&2
      exit 2 ;;
    *) echo "ERROR: 不明な引数: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$DENYLIST" ]]; then
  # denylist が無い環境では何も判定できない。黙って通すのではなく、
  # 対象リポジトリかどうかも判定できないことを言う（ただし push は止めない）。
  echo "publish-scan: denylist が無いので走査していない: $DENYLIST" >&2
  exit 0
fi

# ---- denylist の読み込み ----
# 形式:
#   [public-repos]   この下に remote URL の部分文字列を1行ずつ（例: yoshiki449/cc-dev-plugins）
#   [deny]           この下に禁止する正規表現を1行ずつ
# 空行と # 始まりは無視。
PUBLIC_REPOS=()
DENY=()
SECTION=""
while IFS= read -r line; do
  line="${line%%$'\r'}"
  [[ -z "${line// /}" ]] && continue
  [[ "${line#\#}" != "$line" ]] && continue
  case "$line" in
    \[public-repos\]) SECTION=repos; continue ;;
    \[deny\]) SECTION=deny; continue ;;
    \[*\]) SECTION=""; continue ;;
  esac
  case "$SECTION" in
    repos) PUBLIC_REPOS+=("$line") ;;
    deny) DENY+=("$line") ;;
  esac
done < "$DENYLIST"

if [[ ${#DENY[@]} -eq 0 ]]; then
  echo "ERROR: denylist の [deny] が空: $DENYLIST" >&2
  exit 2
fi

# ---- 対象リポジトリか ----
if [[ $FORCE -eq 0 ]]; then
  REMOTE="$(git remote get-url origin 2>/dev/null || true)"
  MATCHED=0
  for r in "${PUBLIC_REPOS[@]}"; do
    case "$REMOTE" in *"$r"*) MATCHED=1; break ;; esac
  done
  if [[ $MATCHED -eq 0 ]]; then
    exit 0
  fi
fi

# ---- 走査対象の本文を作る ----
TMP=$(mktemp) || exit 0
trap 'rm -f "$TMP"' EXIT

# コミットのメタデータを走査本文に足す。
#
# ファイルの中身だけを見ていると、**author / committer のメールアドレスを取り逃がす**。
# 実測（Issue #83 Phase 2）: 公開リポジトリを作るとき、スキャンもテストも履歴のファイル名検査も
# 通したあとで、作者メールが勤務先アドレスのままだと目視で気づいた。GitHub は public リポジトリの
# コミット作者メールを誰でも見られる形で公開する。
#
# ファイル本文より手当てが重い。1コミットでも入ると履歴の書き換えと force push が要る。
# 汎用パターンのメールアドレス検査がそのまま効くので、走査対象に混ぜるだけでよい。
#
# タグの tagger と本文も同じ理由で見る。
# 書式は1箇所に持つ。範囲あり／なしで同じ文字列を2回書くと、片方だけ直した状態を
# 作れてしまう（実測: committer を消す変異が、範囲なし側に残った複製のせいで素通りした）。
COMMIT_META_FMT='commit-meta %h author: %an <%ae>%ncommit-meta %h committer: %cn <%ce>%ncommit-meta %h subject: %s%ncommit-meta %h body: %b'
TAG_META_FMT='tag-meta %(refname:short) tagger: %(taggername) %(taggeremail)%0atag-meta %(refname:short) message: %(contents:subject)'

append_commit_metadata() {
  local range="$1"
  local -a range_args=()
  [[ -n "$range" ]] && range_args=("$range")
  git log --no-color --format="$COMMIT_META_FMT" "${range_args[@]}" 2>/dev/null >> "$TMP" || true
  git tag -l --format="$TAG_META_FMT" 2>/dev/null >> "$TMP" || true
}

case "$MODE" in
  diff)
    # 追加行だけを見る。削除行に固有名が出るのは「消した」という意味なので問題ない。
    #
    # upstream が無い場合に **全コミット**を見る点が secret-scan.sh と違う。
    # あちらは過剰スキャンを避けて直近1コミットだけにしているが、upstream が無い状況は
    # 「公開リポジトリへの最初の push」そのもので、そこで全履歴が一度に公開される。
    # 直近1コミットだけ見ると、初回 push で履歴全体を取り逃がす＝最悪の方向に倒れる。
    # 範囲の決定と走査を分ける。分岐ごとに走査を書くと、片方の分岐からだけ
    # 走査が抜けた状態を作れてしまい、そこはテストで踏みにくい（@{push} が解決する環境では
    # @{upstream} の分岐に入らない）。範囲だけ決めて、走査は1箇所で行う。
    RANGE=""
    if git rev-parse '@{push}' >/dev/null 2>&1; then
      RANGE='@{push}..HEAD'
    elif git rev-parse '@{upstream}' >/dev/null 2>&1; then
      RANGE='@{upstream}..HEAD'
    fi

    if [[ -n "$RANGE" ]]; then
      git diff "$RANGE" --unified=0 2>/dev/null | command grep '^+' > "$TMP" || true
    else
      git log --no-color -p --unified=0 2>/dev/null | command grep '^+' > "$TMP" || true
    fi
    append_commit_metadata "$RANGE"
    ;;
  all)
    # xargs はシェル関数を実行できないので `xargs -0 command grep` は必ず失敗し、
    # TMP が空になって「検出なし」で素通りする（実測で踏んだ）。
    # ファイル一覧を配列で受けて command grep に直接渡す。
    mapfile -d '' -t FILES < <(git ls-files -z)
    if [[ ${#FILES[@]} -gt 0 ]]; then
      command grep -nIH '' "${FILES[@]}" 2>/dev/null > "$TMP" || true
    fi
    # 公開前の一括確認なので履歴全体のメタデータも見る
    append_commit_metadata ''
    ;;
  paths)
    [[ ${#PATHS[@]} -gt 0 ]] || { echo "ERROR: --paths にパスが無い" >&2; exit 2; }
    command grep -rnIH '' "${PATHS[@]}" 2>/dev/null > "$TMP" || true
    ;;
esac

if [[ ! -s "$TMP" ]]; then
  exit 0
fi

# ---- 行単位の明示的な除外 ----
# このゲート自身のテストは「弾かれるべきサンプル」を本文に持たなければ成立しない。
# パス単位で除外すると、そのファイルに後から本物が混ざっても無音で素通りするので、
# **1行ごとに印を書かせる**方式にする。印は diff に出るし、件数はテストで固定している。
ALLOW_MARK='publish-scan:allow'
command grep -v -- "$ALLOW_MARK" "$TMP" > "$TMP.filtered" 2>/dev/null || true
mv -f "$TMP.filtered" "$TMP" 2>/dev/null || true
trap 'rm -f "$TMP" "$TMP.filtered"' EXIT

if [[ ! -s "$TMP" ]]; then
  exit 0
fi

# ---- 汎用パターン（denylist に書かなくても常に見る）----
# 組織名と違って、これは公開してよい環境が存在しない。
GENERIC=(
  # 実在しそうなメールアドレス。
  # 許すのは example.com / example.org / example.net（サブドメイン込み）と、
  # RFC 2606 / 6761 の予約 TLD（.invalid / .test / .example / .localhost）だけ。
  # 予約 TLD を許す理由: 「example.com 以外が弾かれること」を検査するテストは、
  # 弾かれる側のアドレスを持たなければならない。そこに実在ドメインを書くと、
  # 誤送信を検査するテストが誤送信先を抱えることになる。
  # 除外は必ずホスト末尾で判定する（末尾を見ないと example.com.evil.example が素通りする）。
  #
  # noreply 系も許す。コミットのメタデータを走査対象に入れた時点で、
  # `<user>@users.noreply.github.com`（GitHub が個人アドレスを隠すために配る形）と
  # `noreply@<domain>` が毎回引っかかるようになった。どちらも連絡先ではないので、
  # **ここを許さないとゲートが毎回鳴り、ALLOW_PUBLISH で飛ばす運用に倒れる**。
  # 鳴りっぱなしのゲートは無いのと同じなので、この2つは明示的に落とす。
  # 先頭の後読みは、除外を書いても途中から一致して素通りするのを防ぐためのもの
  # （これが無いと no-reply@... に対して oreply@... が別に一致してしまう）。
  '(?<![A-Za-z0-9._%+-])(?!no-?reply@)[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*noreply\.)(?![A-Za-z0-9.-]*example\.(com|org|net)(?![A-Za-z0-9.-]))(?![A-Za-z0-9.-]*\.(invalid|test|example|localhost)(?![A-Za-z0-9.-]))(?!localhost(?![A-Za-z0-9.-]))[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
)

HITS=$(mktemp) || exit 0
trap 'rm -f "$TMP" "$HITS"' EXIT

for pat in "${DENY[@]}"; do
  command grep -iE -- "$pat" "$TMP" 2>/dev/null | sed "s|^|[deny:$pat] |" >> "$HITS" || true
done
for pat in "${GENERIC[@]}"; do
  command grep -iP -- "$pat" "$TMP" 2>/dev/null | sed "s|^|[generic] |" >> "$HITS" || true
done

if [[ ! -s "$HITS" ]]; then
  exit 0
fi

{
  echo "=============================================="
  echo " publish-scan: 公開してはいけない語を検出"
  echo "=============================================="
  echo
  sort -u "$HITS" | head -60 | cut -c1-200
  TOTAL=$(sort -u "$HITS" | wc -l)
  [[ "$TOTAL" -gt 60 ]] && echo "... 他 $((TOTAL - 60)) 件"
  echo
  echo "denylist: $DENYLIST"
  echo "対処:"
  echo "  1. 該当箇所を架空の値に置き換える（実測の記録は残し、固有名だけを落とす）"
  echo "  2. 誤検出なら denylist のパターンを絞る（語を消すのではなく範囲を狭める）"
  echo "  3. このリポジトリを公開対象から外すなら denylist の [public-repos] から削る"
} >&2

exit 1
