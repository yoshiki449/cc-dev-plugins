#!/usr/bin/env bash
# pre-bash-push-check.sh
#
# Claude Code の PreToolUse(Bash) hook から起動される。
# stdin に JSON で tool_input.command と cwd が渡される。
# command が `git push` を含むなら 2 本のスキャンを走らせる:
#   1. scripts/secret-scan.sh   … 秘密の値の混入（cwd のリポジトリ）
#   2. scripts/publish-scan.sh  … 公開してはいけない固有名（公開対象リポジトリのみ）
# どちらかが検出したら exit 2 で Bash 実行をブロック。
#
# 失敗時の安全側挙動: 解析エラーや想定外の状況では exit 0（通過）させ、
# 「保護がかからない」より「業務を止めない」を優先する。
# ただし「明らかに検出した」場合は確実に exit 2 する。
#
# ⚠ ブロックできる終了コードは 2 だけ。PreToolUse の契約は
#   exit 0   … 通過（stdout/stderr は表示されない）
#   exit 2   … stderr をモデルに見せてツール実行をブロック
#   その他   … stderr をユーザーに見せるが**実行は続行する**
# ここを 1 にすると、検出メッセージだけ出して push はそのまま通る。
# v0.1.0 から v0.2.1 までこの状態で、ゲートは一度も push を止めていなかった
# （実測: denylist の語を含むコミットが公開リポジトリへ通った）。
# 配下の secret-scan.sh / publish-scan.sh は単体実行もするので exit 1 のまま。
# 1 から 2 への翻訳はこの hook の責務。

set -uo pipefail

# --- stdin から JSON を読み、command / cwd を取り出す ---
INPUT_JSON=$(cat 2>/dev/null || echo '{}')

# python3 で安全に JSON parse（jq 非依存）
PARSED=$(python3 - "$INPUT_JSON" <<'PY' 2>/dev/null || true
import json
import sys
try:
    data = json.loads(sys.argv[1])
    cmd = (data.get("tool_input") or {}).get("command", "")
    cwd = data.get("cwd", "")
    print(f"COMMAND<<<EOM\n{cmd}\nEOM\nCWD={cwd}")
except Exception:
    pass
PY
)

# 解析結果から COMMAND/CWD を抽出
COMMAND=$(echo "$PARSED" | awk '/^COMMAND<<<EOM$/{flag=1;next}/^EOM$/{flag=0}flag' | sed 's/$//')
CWD=$(echo "$PARSED" | grep '^CWD=' | head -1 | sed 's/^CWD=//')

# git push が含まれないなら何もしない。
# ここが唯一の絞り込みで、登録側（hooks.json）には条件を書かない。
# `"if": "Bash(git push:*)"` は先頭一致なので `cd /repo && git push` を取り逃がし、
# hook 自体が起動しない。worktree 運用ではその形で push するため、実測では
# 公開リポジトリへ denylist の語を含むコミットがそのまま通った。
# 下の cd 先の解決（CANDIDATES）は、呼ばれて初めて意味を持つ。
if ! echo "$COMMAND" | grep -qE '\bgit[[:space:]]+push\b'; then
  exit 0
fi

# 環境変数バイパス。
# ⚠ ALLOW_SECRETS は秘密スキャンだけを飛ばす。publish-scan は別の失敗モード
#   （公開してはいけない固有名が外に出る＝取り消せない）なので巻き添えで無効化しない。
#   publish-scan を飛ばすには ALLOW_PUBLISH=1 を明示する。
SKIP_SECRET=0
if [[ "${ALLOW_SECRETS:-0}" == "1" ]]; then
  echo "[git-secret-guard] ALLOW_SECRETS=1 により秘密スキャンをスキップ" >&2
  SKIP_SECRET=1
fi

# cwd へ移動（取得できなかったら現在のディレクトリのまま）
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  cd "$CWD" || true
fi

# git リポジトリでないなら何もしない
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# 検出時の終了コード。PreToolUse がブロックと解釈するのは 2 だけ（上の契約を参照）。
BLOCK=2
STATUS=0

# --- 走査先の決定 ---
# cwd だけに頼らない。`cd /other/repo && git push` のようにコマンド側で移動している場合、
# cwd のリポジトリを見ても push される中身とは別物になる。cwd とコマンド中の移動先の
# **両方**を候補にして、それぞれで2本とも回す。
#
# 2本を同じループに入れているのは、片方だけに候補解決が付いている状態を作らないため。
# 実際に v0.2.2 まで publish-scan にだけ付いており、`cd /repo && git push` では
# 秘密スキャンが cwd 側の無関係なリポジトリを見ていた（実測: 偽のトークンを含む
# コミットが素通りした）。候補を増やしても、2本とも対象外なら自分で no-op に落ちる。
CANDIDATES=("$PWD")
# cd / pushd の直後のトークンを拾う。クォートは剥がす。網羅ではない
# （eval や変数展開の先は追えない）ので、cwd 側の候補と併せて二重に見ている。
while read -r d; do
  [[ -n "$d" ]] && CANDIDATES+=("$d")
done < <(echo "$COMMAND" | command grep -oE '\b(cd|pushd)[[:space:]]+("[^"]+"|'"'"'[^'"'"']+'"'"'|[^[:space:];&|)]+)' \
           | sed -E 's/^(cd|pushd)[[:space:]]+//; s/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')

SECRET_SCAN="${CLAUDE_PLUGIN_ROOT}/scripts/secret-scan.sh"
PUBLISH_SCAN="${CLAUDE_PLUGIN_ROOT}/scripts/publish-scan.sh"

if [[ "${ALLOW_PUBLISH:-0}" == "1" ]]; then
  echo "[git-secret-guard] ALLOW_PUBLISH=1 により公開前スキャンをスキップ" >&2
fi

SEEN=""
for d in "${CANDIDATES[@]}"; do
  [[ -d "$d" ]] || continue
  ROOT=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || continue
  case "$SEEN" in *"|$ROOT|"*) continue ;; esac
  SEEN="$SEEN|$ROOT|"

  # 1. 秘密スキャン（未 push 範囲に秘密の値が入っていないか）
  if [[ $SKIP_SECRET -eq 0 ]]; then
    ( cd "$ROOT" && bash "$SECRET_SCAN" ) || STATUS=$BLOCK
  fi

  # 2. 公開前スキャン（remote が [public-repos] に載っているリポジトリだけ）
  if [[ "${ALLOW_PUBLISH:-0}" != "1" ]]; then
    ( cd "$ROOT" && bash "$PUBLISH_SCAN" ) || STATUS=$BLOCK
  fi
done

exit $STATUS
