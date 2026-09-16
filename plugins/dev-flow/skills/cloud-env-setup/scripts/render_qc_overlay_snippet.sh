#!/usr/bin/env bash
# render_qc_overlay_snippet.sh
#
# 組織固有の QC overlay（skills/_shared/reference/qc-overlay.md 参照）の中身を、
# クラウド環境の「Setup script」欄に貼り付けられる bash スニペットとして標準出力に出す。
#
# クラウド VM は $HOME がセッションごとにリセットされるため、ローカル用の overlay 配置
# （組織側 plugin の install_overlay.py 等）はクラウドには届かない。Setup script だけが
# Claude 起動前に届く唯一の経路なので、overlay ファイルの中身をそのまま heredoc で
# 埋め込んで Setup script に持ち込む。実際の観点テキストは社内資産なので、このスクリプト
# 自体は overlay の中身を一切知らず、実行時にローカルの overlay ディレクトリを読むだけ。
#
# 使い方:
#   bash render_qc_overlay_snippet.sh [--overlay-dir <path>]
#
# 終了コード:
#   0: 出力した
#   1: overlay ディレクトリが無い/ファイルが1つも無い/manifest.json が無い、またはデリミタ衝突
#   2: 引数エラー・--help
set -euo pipefail

OVERLAY_DIR=""

print_usage() {
  cat <<'USAGE' >&2
render_qc_overlay_snippet.sh — QC overlay を Setup script 用の bash スニペットにする

  bash render_qc_overlay_snippet.sh [--overlay-dir <path>]

  --overlay-dir <path>   overlay の置き場所。既定は $CC_PLUGINS_OVERLAY_DIR、
                         未設定なら ~/.cc-plugins/overlay/qc（qc-overlay.sh と同じ）
  --help                 このヘルプ

出力を claude.ai/code の環境設定「Setup script」欄に、plugin 導入ブロックの後・
末尾の wait の前に貼り付ける。overlay の構成は
skills/_shared/reference/qc-overlay.md を参照。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --overlay-dir)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --overlay-dir には値が必要です" >&2
        print_usage
        exit 2
      fi
      OVERLAY_DIR="$2"; shift 2 ;;
    --help|-h) print_usage; exit 2 ;;
    *) echo "ERROR: 不明な引数: $1" >&2; print_usage; exit 2 ;;
  esac
done

if [[ -z "$OVERLAY_DIR" ]]; then
  OVERLAY_DIR="${CC_PLUGINS_OVERLAY_DIR:-$HOME/.cc-plugins/overlay/qc}"
fi

# qc-overlay.sh の PHASES と同じ7フェーズ。ファイル名は manifest.json も含めて
# qc-overlay.md の「ディレクトリ構成」に固定されている。
NAMES=(manifest.json plan.md impl.md test-spec.md verify.md qa.md ship.md test-model.md)

FOUND=()
for name in "${NAMES[@]}"; do
  [[ -f "$OVERLAY_DIR/$name" ]] && FOUND+=("$name")
done

if [[ ${#FOUND[@]} -eq 0 ]]; then
  echo "ERROR: overlay が見つからない: $OVERLAY_DIR（manifest.json も <phase>.md も無い）" >&2
  exit 1
fi

# manifest.json を必須にする。フェーズファイルだけあっても、貼り付け先の qc-overlay.sh は
# manifest.json が無いと全フェーズ overlay_applied=0 を返す（qc-overlay.sh の契約）。
# ここで許すと「生成・貼り付けは成功したのにQC観点が1つも効いていない」を黙って作れてしまう。
HAS_MANIFEST=0
for name in "${FOUND[@]}"; do
  [[ "$name" == "manifest.json" ]] && HAS_MANIFEST=1
done
if [[ "$HAS_MANIFEST" -eq 0 ]]; then
  echo "ERROR: manifest.json が無い: $OVERLAY_DIR（フェーズファイルはあるが、manifest.json が無いと貼り付け先で全フェーズ overlay_applied=0 になる）" >&2
  exit 1
fi

DELIM="QC_OVERLAY_EOF"

# デリミタ衝突チェック。$DELIM という行を含むファイルは、シングルクオート heredoc でも
# その行で早期終端し、出力が黙って壊れる。動的にデリミタを変えるより、
# 衝突したら明示的に止めて手当てを促す方を選ぶ。
for name in "${FOUND[@]}"; do
  file="$OVERLAY_DIR/$name"
  if grep -qxF "$DELIM" "$file"; then
    echo "ERROR: $file に区切り文字列と衝突する行（$DELIM）が含まれるため埋め込めない" >&2
    exit 1
  fi
done

echo "# QC overlay をクラウド環境に持ち込むブロック（render_qc_overlay_snippet.sh で生成）"
echo "# plugin 導入ブロックの後・末尾の wait の前に貼ること"
# -m 700 で作成時から権限を絞る。mkdir 後に chmod する形だと、既定 umask のディレクトリが
# 一瞬でも存在する（社内資産を置く場所なので、その間隙を作らない）。
echo "mkdir -p -m 700 ~/.cc-plugins/overlay/qc"

for name in "${FOUND[@]}"; do
  file="$OVERLAY_DIR/$name"
  dest="~/.cc-plugins/overlay/qc/$name"
  echo "cat > $dest <<'$DELIM'"
  cat "$file"
  # heredoc の終端行は必ずそれだけで1行を成す必要がある。元ファイルが改行無しで
  # 終わっていると、直前の内容行に $DELIM がそのまま連結されて終端と認識されず、
  # 後続の全行が heredoc に飲み込まれる（実測で踏んだ）。改行を1つ補って終端行を
  # 独立させ、そのぶんは書き込み後に truncate -s -1 で削って往復一致を保つ。
  no_trailing_nl="$(tail -c1 "$file")"
  if [[ -n "$no_trailing_nl" ]]; then
    printf '\n'
  fi
  echo "$DELIM"
  if [[ -n "$no_trailing_nl" ]]; then
    echo "truncate -s -1 $dest"
  fi
  # 書き込み直後に個別 chmod する。全ファイル出力後にまとめて chmod すると、
  # 既定パーミッション（644）のまま存在する時間が長くなる。
  echo "chmod 600 $dest"
done
