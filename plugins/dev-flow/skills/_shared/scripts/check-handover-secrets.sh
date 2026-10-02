#!/usr/bin/env bash
# 引継書に資格情報らしい行が無いか走査する。
# 使い方: check-handover-secrets.sh <引継書のパス>
# 終了コード: 0=検出なし / 1=検出あり / 2=引数・ファイルの誤り
#
# 引継書はリポジトリに追跡される（クラウドセッションが新しい clone だけで前のフェーズの文脈を読むため）。
# コミットされた資格情報は history に残るので、コミットの前に走査する。
#
# 出力は「ファイル:行番号: 種類」だけにする。検出した値そのものを出すと、走査結果を表示した
# ターミナルやログに値が残り、走査が漏えい経路になる。
#
# 検出するのは、語（パスワード・token 等）の直後に区切り（: ： =）と4文字以上の値が続く行など、
# 「値が書かれている」形だけ。「パスワードは .env を参照」のような説明や、<...> の
# プレースホルダ、40桁の16進（コミットの SHA）は検出しない。誤検出は書き直しで避けられる側に倒してある
# （ユーザー名と取得元を書き、値は書かない）。
set -uo pipefail

# 全角の区切りや省略記号を文字クラスで扱うため、UTF-8 のロケールで grep する
# （ロケール名の表記は環境で違う: C.UTF-8 / C.utf8。名前の一致でなく、文字コードで判定する）
for loc in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8 ja_JP.UTF-8 ja_JP.utf8; do
  if [ "$(LC_ALL=$loc locale charmap 2>/dev/null)" = "UTF-8" ]; then
    export LC_ALL="$loc"
    break
  fi
done

if [ $# -lt 1 ]; then
  echo "usage: check-handover-secrets.sh <handover-file>" >&2
  exit 2
fi
file=$1
if [ ! -f "$file" ]; then
  echo "ERROR: not a file: $file" >&2
  exit 2
fi

found=0

# report <種類> <grep のオプション> <正規表現>
report() {
  local kind=$1 opts=$2 re=$3 ln
  while IFS= read -r ln; do
    echo "$file:$ln: $kind"
    found=1
  done < <(grep -n $opts -e "$re" -- "$file" | cut -d: -f1)
}

# 語の直後に区切りと値が続く行。値の先頭が < … （ ( のものはプレースホルダ・説明として除く
report "資格情報の代入（パスワード・トークン等）" "-Ei" \
  "(パスワード|password|passwd|pwd|secret|token|api[_ -]?key|シークレット|トークン|秘密鍵)[^[:space:]:：=]*[[:space:]]*[:：=][[:space:]]*[^[:space:]<…（(][^[:space:]]{3,}"
report "Bearer トークン" "-Ei" "Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{16,}"
report "URL に埋め込まれた資格情報" "-Ei" "[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@"
report "既知のトークンの接頭辞" "-E" \
  "(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})"
report "秘密鍵" "-E" "-----BEGIN [A-Z ]*PRIVATE KEY-----"

[ "$found" -eq 0 ]
