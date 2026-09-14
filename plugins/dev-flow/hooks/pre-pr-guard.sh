#!/bin/bash
# dev-ship 経由チェックフック（成果物欠落の最終防衛線）
# PreToolUse(Bash) で発火し、PR 作成コマンドが dev-ship チェーンを経由しているかを
# マーカーファイル（中身=ship 対象のブランチ名）で判定する。
# マーカーが対象リポの現ブランチと一致しなければ exit 2 でブロックし、
# /dev-ship 経由 or 成果物生成済みならマーカー書き込みを指示する。
# 入口漏れの経路（ship 後の後続タスク・短い応答・AskUserQuestion 回答等）が
# 何であっても、実害（explain-diff / hub-run 欠落）が確定する一点で捕捉する設計。
# dev-flow を使っていないリポジトリ（.agent/ なし）では発火しない。
#
# 判定対象リポの決め方（Issue #39）と マーカーの置き場所（Issue #36）は、どちらも
# 「cwd がどこを向いていたか」に左右されてはいけない。ship 対象は cwd ではなく
# コマンドが実際に触るリポジトリであり、マーカーは worktree と main clone で
# 同じ実体を指す必要がある。
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# PR 作成コマンド以外は対象外。
# クォートで囲まれた部分（コミットメッセージ・ヒアドキュメントに書いたコード例等）に
# 含まれる文字列での誤検知を防ぐため、先に除去してから判定する。
# **バッククォートも剥がす**: JS のテンプレートリテラルや Markdown のインラインコードは
# バッククォートで囲まれるため、旧実装ではこのフック自身のテストを書く操作がブロックされた
# （実測。#33 と同じ PR で発見した）。
# 除去は下の SOURCE_TEXT の組み立てで行う（ヒアドキュメントの除去と順序が決まっているため）。

# ⚠ ただし `bash -c "..."` `sh -c '...'` `eval "..."` は、**クォートの中身が地の文ではなく
# 実際に実行されるコマンドそのもの**なので、除去してしまうと検査対象が消える
# （実測: `bash -c "cd <別リポ> && gh pr create"` が exit 0 で素通りしていた。main から在る穴）。
# これらのラッパーが現れたら、検出はクォートを剥がしていない原文に対して行う。
# 代償として「コミットメッセージに bash -c と PR 作成コマンドの両方を書いた」ケースを
# 拾いうるが、その場合も対象リポの解決に進むだけで、判定は fail-closed 側に倒れる。
# ヒアドキュメントをシェルに食わせる形（`bash <<EOF ... EOF`）も同じ扱い。
# この本体は「コマンドへ渡す入力」ではなく**実行されるコマンド**なので落としてはいけない。
IS_WRAPPER=0
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|(]|[[:space:]])((ba|z|da)?sh[[:space:]]+-c|eval)([[:space:]]|$)'; then
  IS_WRAPPER=1
elif printf '%s' "$COMMAND" | grep -qE '(^|[;&|(]|[[:space:]])((ba|z|da)?sh|source|\.)[[:space:]]*<<'; then
  IS_WRAPPER=1
fi

# ヒアドキュメントの本体は**コマンドへ渡すデータ**であって実行されるコマンドではない
# （Issue #68）。実測: PR 作成コマンドの説明を書いた Issue 起票コマンドがブロックされた。
# クォートと違い区切りが行単位なので、行を読みながら本体を落とす。
# ラッパー経由のときは上記のとおり本体が実行対象なので落とさない。
strip_heredoc_bodies() {
  awk '
    # 行の中で、**クォートの外にある** << を探して区切り語を返す。
    # クォートを見ないと `echo "docs<<EOF"` を開始と誤認し、続きの行を本体として
    # 丸ごと落とす。実機の bash ではこれはヒアドキュメントにならないので、
    # 落とした行に別リポジトリへの移動があるとガードを抜けられる（実測で確認）。
    # 返り値の 2 文字目以降が区切り語で、先頭 1 文字が `-` 付きかどうかの印。
    function heredoc_delim(line,   i, c, q, rest, dash, d) {
      q = ""
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (q != "") { if (c == q) { q = "" } ; continue }
        if (c == "\"" || c == "'"'"'") { q = c; continue }
        if (c == "<" && substr(line, i + 1, 1) == "<") {
          rest = substr(line, i + 2)
          dash = 0
          if (substr(rest, 1, 1) == "-") { dash = 1; rest = substr(rest, 2) }
          sub(/^[ \t]+/, "", rest)
          if (match(rest, /^("[^"]+"|'"'"'[^'"'"']+'"'"'|[A-Za-z_][A-Za-z0-9_]*)/)) {
            d = substr(rest, RSTART, RLENGTH)
            gsub(/["'"'"']/, "", d)
            return (dash ? "-" : "+") d
          }
          return ""
        }
      }
      return ""
    }
    BEGIN { delim = ""; dash = 0 }
    delim != "" {
      line = $0
      # タブを剥がして終端と照合してよいのは `<<-` のときだけ。
      # `<<` では行頭一致でなければ終端ではないので、緩く見ると本体が早く終わり、
      # 続きの行が走査対象に戻る。
      if (dash) { sub(/^\t+/, "", line) }
      if (line == delim) { delim = "" }
      next
    }
    {
      print
      d = heredoc_delim($0)
      if (d != "") {
        dash = (substr(d, 1, 1) == "-")
        delim = substr(d, 2)
      }
    }
  '
}

if [ "$IS_WRAPPER" -eq 1 ]; then
  SCAN="$COMMAND"
  SOURCE_TEXT="$COMMAND"
else
  SOURCE_TEXT=$(printf '%s' "$COMMAND" | strip_heredoc_bodies)
  SCAN=$(printf '%s' "$SOURCE_TEXT" | sed "s/'[^']*'//g" | sed 's/"[^"]*"//g' | sed 's/`[^`]*`//g')
fi

if ! echo "$SCAN" | grep -qE '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+create'; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
CWD="${CWD:-$PWD}"

# --- 判定対象リポの解決（Issue #39）------------------------------------------
# PreToolUse の .cwd はツール呼び出し時点のディレクトリで、**コマンド文字列の中の
# cd は反映されない**。`cd <別リポ> && gh pr create` を cwd 側のリポで判定すると、
# cwd 側に有効なマーカーが残っているだけで別リポの PR が素通りする（偽陰性）。
#
# PR 作成コマンドより**前**に現れる最後の cd を採用する（シェルの実行順に合わせる）。
# 後ろの cd は PR 作成には影響しないので見ない。
# 抽出は SCAN ではなく SOURCE_TEXT（クォートを剥がす前）から行う。SCAN はクォートで
# 囲まれた部分を丸ごと落とすため、`cd "<パス>"` の形だとパスごと消えてしまう
# （検出用と抽出用で入力が違う）。クォートの中身を拾わないようにするのは、
# 除去ではなく**コマンドの位置に限定する**ことで行う（下の CD_DELIM）。
# 切り出しは**文字列全体の最初の1回**で行う。sed は行単位なので、PR 作成コマンドと
# 同じ行しか切り落とせず、**後ろの行がそのまま残る**。`--body` の値が実際の改行を含むと
# その残った行が走査対象に入り、行頭（＝コマンドの位置）から始まる移動コマンドが
# 移動先として採用されていた（実測で誤ブロックを再現。#68 と同じ失敗モードの別形態）。
BEFORE_PR=$(printf '%s' "$SOURCE_TEXT" | awk '
  { if (match($0, /(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+create/)) {
      print substr($0, 1, RSTART - 1); exit
    }
    print
  }')
# `pushd` も拾う（cd と同じく以降のコマンドの実行先を変えるため。実測で素通りを確認）。
# 区切り文字に `(` と クォートを含めるのは、`(cd <別リポ> && ...)` のサブシェル形と
# `bash -c "cd <別リポ> && ..."` のラッパー形を拾うため（どちらも cd の直前が
# 空白・`;&|` ではない。実測で素通りを確認した）。
# **コマンドの位置に現れた移動コマンドだけを拾う**（Issue #68）。
# 直前が空白でも拾っていたため、`--body "hook の cd 候補収集を消す"` のような
# 自然文の途中が移動先として切り出されていた（実測でブロックされた）。
# 区切りは行頭か `;` `&` `|` `(` に限る。`&& cd /x` は `&` のあとの空白を挟んで一致する。
#
# クォートを区切りに含めるのはラッパー経由のときだけ。`bash -c "cd /x && ..."` では
# クォートの直後がコマンドの位置になるが、そうでない場合のクォートは
# 「地の文の始まり」でしかない。ここを区別しないと本文の自然文を拾う。
# シェルのキーワードの直後もコマンドの位置。ここを落とすと、別リポジトリへの移動を
# 条件分岐やループの中に置くだけでガードを抜けられる（実測: 旧版はブロックしていた形が
# 素通りした。`if true; then cd <別リポ> && ...` / `for ... do ...` / `{ ... }`）。
# `{` は記号側に入れる。`{ cd /x && ... ; }` のように**行頭に来る**ので、
# 直前の空白を要求するキーワード側では拾えない（実測でここだけ素通りした）。
# `command` / `builtin` は cd が組み込みなので呼び出しに使える。直前が空白なだけの
# この形も取りこぼすと、`command cd <別リポ> && ...` でガードを抜けられる（実測）。
# コマンドの位置 = 行頭、または `;` `&` `|` `(` `{` の直後。
# ラッパー経由のときだけクォートも足す。差はその2文字だけなので正規表現を書き分けない
# （書き分けると片方だけ直す事故が起きる）。
QUOTES=""
[ "$IS_WRAPPER" -eq 1 ] && QUOTES="\"'"
CD_START="(^|[;&|({${QUOTES}])"

# コマンドの位置と `cd` の間に挟まってよい語。シェルのキーワードと、
# 組み込みを明示的に呼ぶ 2 つ。**行頭にも来る**ので区切りの一部ではなく
# 「区切りと cd の間に挟まるもの」として扱う（実測: 直前の空白を要求する書き方だと
# 行頭の `command cd` と `{ cd` を取りこぼした）。
CD_PREFIX="((then|else|elif|do|in|!|command|builtin)[[:space:]]+)*"

CD_RAW=$(printf '%s' "$BEFORE_PR" \
  | grep -oE "${CD_START}[[:space:]]*${CD_PREFIX}(cd|pushd)[[:space:]]+(--[[:space:]]+)?(\"[^\"]*\"|'[^']*'|[^;&|()\"'[:space:]]+)" \
  | tail -1 \
  | grep -oE "(cd|pushd)[[:space:]]+(--[[:space:]]+)?(\"[^\"]*\"|'[^']*'|[^;&|()\"'[:space:]]+)$" \
  | sed -E "s/^(cd|pushd)[[:space:]]+(--[[:space:]]+)?//")
# 前後のクォートを外す（パスに空白を含む場合はクォートが必須）
CD_RAW="${CD_RAW%\"}"; CD_RAW="${CD_RAW#\"}"
CD_RAW="${CD_RAW%\'}"; CD_RAW="${CD_RAW#\'}"

TARGET_DIR="$CWD"
CD_SPECIFIED=0
if [ -n "$CD_RAW" ]; then
  CD_SPECIFIED=1
  # ~ だけは展開する（$VAR は展開できないので下の解決失敗で fail-closed に倒れる）。
  case "$CD_RAW" in
    "~") CD_RAW="$HOME" ;;
    "~/"*) CD_RAW="$HOME/${CD_RAW#\~/}" ;;
  esac
  case "$CD_RAW" in
    /*) TARGET_DIR="$CD_RAW" ;;
    *) TARGET_DIR="$CWD/$CD_RAW" ;;
  esac
fi

REPO_ROOT=$(git -C "$TARGET_DIR" rev-parse --show-toplevel 2>/dev/null)

if [ -z "$REPO_ROOT" ]; then
  # cd が明示されていたのに対象リポを解決できない場合は **ブロック側に倒す**。
  # ここで素通りさせると「解決できなかったから通した」と「経由済みだから通した」の
  # 区別がつかず、ガードの性質上いちばん危険な失敗になる（Issue #39: fail-closed）。
  if [ "$CD_SPECIFIED" -eq 1 ]; then
    cat >&2 <<EOF
[dev-flow] ブロック: PR 作成先のリポジトリを特定できませんでした（cd 先: $TARGET_DIR）。
dev-ship 経由かどうかを判定できないため、安全側でブロックしています。

上の「cd 先」が意図した移動先でないなら、原因はコマンド文字列の側にあります:
  - 移動先に \$VAR を使っている → このフックは変数を展開できません。絶対パスで書いてください
  - PR の本文やタイトルに移動コマンドの文字列が入っている → --body-file に切り替えてください
意図した移動先が出ているなら、そのディレクトリが git リポジトリか確認してください。
EOF
    exit 2
  fi
  # cd の指定が無く cwd もリポ外なら、そもそも PR 作成は成立しない（対象外）。
  exit 0
fi

# --- マーカーの置き場所（Issue #36）------------------------------------------
# .agent/ は保管規約で gitignore されるため **worktree にはチェックアウトされない**。
# マーカーを .agent/ に置くと worktree では見つからず、main clone 側に "main" と
# 書かれたマーカーが残るとガードが恒久的に無効化されていた。
# .git の実体（--git-common-dir）は worktree と main clone で共有されるので、
# そこに置けばどちらから見ても同じ1つのマーカーになる。
GIT_COMMON=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON" ]; then
  # REPO_ROOT は取れたのに .git 実体が引けない＝判定材料が欠けている状態。
  # ここで exit 0 にすると「解決できなかったから通した」と「経由済みだから通した」の
  # 区別がつかず、上の解決失敗と非対称になる（同じ欠落なのに片方だけ素通り）。
  cat >&2 <<EOF
[dev-flow] ブロック: $REPO_ROOT の .git 実体を特定できませんでした（マーカーの場所が決まらない）。
dev-ship 経由かどうかを判定できないため、安全側でブロックしています。
EOF
  exit 2
fi
case "$GIT_COMMON" in
  /*) ;;
  *) GIT_COMMON="$REPO_ROOT/$GIT_COMMON" ;;
esac
MARKER="$GIT_COMMON/dev-ship-active"

# dev-flow 運用の足跡（.agent/）が無いリポジトリでは発火しない（スコープガード）。
# worktree には .agent/ が無いのが正常なので、**main worktree 側も見る**
# （見ないと worktree からの PR 作成がガードごと素通りする。Issue #36）。
MAIN_WORKTREE=$(dirname "$GIT_COMMON")
if [ ! -d "$REPO_ROOT/.agent" ] && [ ! -d "$MAIN_WORKTREE/.agent" ]; then
  exit 0
fi

BRANCH=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)

# マーカーが対象リポの現ブランチ名と一致 = dev-ship チェーン内の PR 作成 → 通す（idempotent）
if [ -f "$MARKER" ] && [ -n "$BRANCH" ] && [ "$(tr -d '[:space:]' < "$MARKER")" = "$BRANCH" ]; then
  exit 0
fi

cat >&2 <<EOF
[dev-flow] ブロック: この PR 作成は /dev-ship を経由していません（explain-diff / hub-run 成果物の欠落防止）。
対象リポジトリ: $REPO_ROOT（ブランチ: ${BRANCH:-不明}）
次のいずれかを実行してから再試行してください:
  A.（推奨）Skill ツールで dev-ship スキルを起動し、その手順（最終テスト→セルフレビュー→PR作成→explain-diff→hub-run 登録）の中で PR を作成する
  B. すでに成果物を生成済みの場合（auto-build の Finalize 等）: git -C "$REPO_ROOT" branch --show-current > "$MARKER" を実行してから再実行する
EOF
exit 2
