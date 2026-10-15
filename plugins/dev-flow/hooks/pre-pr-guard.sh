#!/bin/bash
# PR の作成とマージを扱うフック（Issue #64）。PreToolUse(Bash) と PreToolUse(PR マージの MCP ツール) で発火する。
#
# - PR マージ（gh pr merge / マージ API / MCP の merge_pull_request）: 常に permissionDecision=ask を返し、
#   利用者への承認確認を必ず挟む。マージは取り返しがつかないので、承認の根拠は利用者の応答だけにする。
#   dev-ship-active マーカーは根拠にしない: dev-ship / auto-build が自分で書くので、流用すると
#   skill の書き込みがそのまま承認になってしまう。
# - PR 作成（gh pr create）: **ブロックしない**。PR は作るだけなら取り返しがつくため。
#   dev-ship を経由していない（マーカーが対象リポの現ブランチと一致しない）ときだけ、
#   explain-diff / hub-run の成果物が未生成かもしれないという注意を additionalContext で注入する。
#   dev-flow を使っていないリポジトリ（.agent/ なし）では出さない。
#
# 判定対象リポの決め方（Issue #39）と マーカーの置き場所（Issue #36）は、どちらも
# 「cwd がどこを向いていたか」に左右されてはいけない。ship 対象は cwd ではなく
# コマンドが実際に触るリポジトリであり、マーカーは worktree と main clone で
# 同じ実体を指す必要がある。注意書きの出し分けにも同じ解決を使う（出すべき先を取り違えると、
# 別リポの dev-ship 済みを理由に未経由のリポで黙る／逆に経由済みのリポで騒ぐ）。
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

emit_ask() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
}
emit_context() {
  jq -n --arg c "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
}

ASK_MERGE_REASON="[dev-flow] PR のマージです。マージは取り消せないため、実行前に利用者の承認が必要です。"

# GitHub MCP の PR マージ。クラウドセッションは gh が無く MCP で操作するので、Bash だけ見ると素通りする。
case "$TOOL" in
  *merge_pull*|*merge_pr*|*auto_merge*|*enqueue*|*merge_branch*) emit_ask "$ASK_MERGE_REASON"; exit 0 ;;
esac

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
# 拾いうるが、その場合も対象リポの解決に進むだけで、注意書きが出るかどうかが変わるだけ。
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

# --- PR マージ: 常に承認確認 ---------------------------------------------------
# **クォート・ヒアドキュメントを「データ」として消してから探す方式は使わない。**
# 消す側とシェルの解釈がずれると、検出対象ごと消えて承認なしのマージが通る（実測で再現した10形態）:
#   gh pr "merge" / gh "pr" merge / mer\ge（語の内側の引用符・バックスラッシュ）、
#   `echo it\'s; gh pr merge; echo 'x'`（エスケープされた引用符を引用の開始と誤認して間を消す）、
#   `echo $((1 << EOF))` の次行（算術の << をヒアドキュメントと誤認して以降を落とす）、
#   `sh -s <<EOF` / `python3 - <<EOF`（本体が実行されるのに、シェル直渡し以外はデータ扱い）、
#   gh pr -R o/r merge（フラグを挟む）、pulls/$N/merge（番号が変数）、行継続での分割。
# 見落としはそのまま承認なしのマージになる一方、見すぎた場合の代償は確認が1回増えるだけなので、
# 内容は消さず、引用符・バックスラッシュ・バッククォートの**文字だけ**を外し、改行は空白にして探す。
# 代償として、コミットメッセージや PR 本文にこれらの文字列を書いただけでも確認が出る（意図した挙動）。
# 検出できないもの: gh の alias 経由（gh alias set）、別ファイルのスクリプトの中、base ブランチの ref を
# 直接書き換える API（git/refs の PATCH）、手元からの git push（PR のマージ操作ではない）。
# ${IFS} / $IFS の空白への置き換えは、**引用符を外す前**に行う。外したあとだと `$IFS'pr'` の境界が
# 失われて `$IFSpr`（別の変数）と区別できない。また `$IFS_X` のような別名の変数を巻き込まないよう、
# `$IFS` の直後が識別子の文字のときは置き換えない（置き換えると `$` が消えて動的な組み立てを見落とす）。
MERGE_TEXT=$(printf '%s' "$COMMAND" \
  | sed -E 's/\$\{IFS\}/ /g; s/\$IFS([^[:alnum:]_]|$)/ \1/g' \
  | tr '`' '(' | tr -d "\"'\\\\" | tr '\n\t' '  ')
# 終端は空白に限らない（`gh pr merge;` `gh pr merge)` `gh pr merge&&` を取り逃がす。実測）。
TERM_END='([^[:alnum:]_-]|$)'
# gh の位置は、gh そのものか、`$` を含む語（`$G pr merge` / `${GH} pr merge`）。
GH_TOK='(gh|[^[:space:]]*\$[^[:space:]]*)'
# gh pr [フラグ [値]]... merge。`gh pr -R o/r merge` のように gh pr の直後にフラグが挟まる形を含む。
# gh pr create --body "... merge ..." のような作成コマンドは、create がフラグではないので当たらない。
PR_FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*'
GH_PR_MERGE="(^|[^[:alnum:]_-])${GH_TOK}[[:space:]]+pr${PR_FLAGS}[[:space:]]+merge${TERM_END}"
# サブコマンドの位置が動的（`gh pr $M` `gh pr $(echo merge)` `gh pr {merge,}`）なら、何を実行するか
# 読めないので確認に倒す。
GH_PR_DYNAMIC="(^|[^[:alnum:]_-])${GH_TOK}[[:space:]]+pr${PR_FLAGS}[[:space:]]+[^[:space:]]*[\$\{(]"
# マージ API: `pulls` があり、`/merge` か `-merge`（`pulls/N/merge` `pulls/N/auto-merge`）が同じコマンドにあれば当てる
# （番号が変数、URL を文字列連結、などの形を拾うため）。`mergeable` は当てない。
# ブランチ同士をマージする `repos/.../merges` も、PR を経ずに base ブランチへ入るので同じ扱い。
# **フラグの値に空白がある形**（`gh pr --repo "my org/r" merge`）は、引用符を外すと値が2語に割れて
# 上のフラグ並びの正規表現が切れる（実測で素通り）。そこで、gh pr の直後が読み取り・作成系の
# サブコマンドの区間（`;` `&` `|` `(` `)` まで）を先に取り除き、残った区間に `gh pr ... merge` があれば確認に倒す。
# 取り除くのは区間だけなので、`gh pr view 1 && gh pr --repo "a b" merge` の後半は残る。
GH_PR_BENIGN='gh[[:space:]]+pr[[:space:]]+(create|view|list|status|checks|diff|comment|edit|close|reopen|ready|review|checkout|lock|unlock)([^[:alnum:]_-][^;&|()]*)?'
GH_PR_ANY="(^|[^[:alnum:]_-])${GH_TOK}[[:space:]]+pr[[:space:]]+[^;&|()]*[[:space:]]merge${TERM_END}"
MERGE_REST=$(printf '%s' "$MERGE_TEXT" | sed -E "s/${GH_PR_BENIGN}//g")
# GraphQL: mergePullRequest / enablePullRequestAutoMerge（auto-merge の予約）/ enqueuePullRequest（merge queue）/ mergeBranch。
# hub merge も同じ。
if printf '%s' "$MERGE_TEXT" | grep -qE "$GH_PR_MERGE" \
  || printf '%s' "$MERGE_TEXT" | grep -qE "$GH_PR_DYNAMIC" \
  || printf '%s' "$MERGE_REST" | grep -qE "$GH_PR_ANY" \
  || { printf '%s' "$MERGE_TEXT" | grep -q 'pulls' && printf '%s' "$MERGE_TEXT" | grep -qE "[/-]merge${TERM_END}"; } \
  || printf '%s' "$MERGE_TEXT" | grep -qE "/repos/[^[:space:]]+/merges${TERM_END}|repos/[^[:space:]]+/merges${TERM_END}" \
  || printf '%s' "$MERGE_TEXT" | grep -qE 'mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch' \
  || printf '%s' "$MERGE_TEXT" | grep -qE "(^|[^[:alnum:]_-])hub[[:space:]]+merge${TERM_END}"; then
  emit_ask "$ASK_MERGE_REASON"
  exit 0
fi

# --- マージ操作を隠せる構文: デコードして実行・シェルへの流し込み ---------------------
# `echo Z2g… | base64 -d | sh` `printf '\x67\x68 pr merge' | sh` `xxd -r | sh`
# `python3 -c "os.system(chr(103)+…)"` は、実行されるコマンドがテキストに現れないので、
# 文字列の検出では原理的に塞げない（実測で素通り）。そこで**構文そのもの**を確認に倒す。
# 通常の作業で使うことはまずないので、誤検出の代償は小さい。
# これは「うっかり」と「よくある迂回」を止めるための網であり、悪意のある回避に耐える境界ではない。
# 境界にするなら、GitHub 側のブランチ保護（必須レビュー）か、Claude Code の permissions.ask を併用する。
ASK_HIDDEN_REASON="[dev-flow] デコードして実行する、またはシェルへ流し込むコマンドです。PR のマージを含んでいないか確かめたうえで、実行前に承認してください（マージは取り消せません）。"
if printf '%s' "$MERGE_TEXT" | grep -qE 'base64[[:space:]]+(-[a-zA-Z]*[dD]|--decode)|xxd[[:space:]]+-[a-zA-Z]*r|openssl[[:space:]]+(enc|base64)[[:space:]]+[^|;&]*-d' \
  || printf '%s' "$MERGE_TEXT" | grep -qE '(^|[^[:alnum:]_-])eval([^[:alnum:]_-]|$)' \
  || printf '%s' "$MERGE_TEXT" | grep -qE '\|[[:space:]]*((sudo|env|command|exec|nohup)[[:space:]]+)*((ba|z|da|k)?sh|source)([^[:alnum:]_-]|$)' \
  || printf '%s' "$MERGE_TEXT" | grep -qE '(python3?|node|perl|ruby)[[:space:]]+-[a-zA-Z]*[ce][[:space:]].*(system|exec|subprocess|spawn|popen)'; then
  emit_ask "$ASK_HIDDEN_REASON"
  exit 0
fi

# --- PR 作成: 止めない。dev-ship 未経由のときだけ注意書きを出す ------------------
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
  # ~ だけは展開する（$VAR は展開できないので下の解決失敗で黙って通す）。
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
  # 対象リポを解決できないときは**黙って通す**。このフックは注意書きを出すだけでブロックしないので、
  # 判定材料が欠けた状態で出す注意書きは「経由済みのリポに騒ぐ」誤りになりうる。
  # 解決できない原因は、移動先の変数（$VAR は展開できない）、本文中の移動コマンドの文字列、
  # 実在しないパスなど。いずれも注意書きを出す根拠にならない。
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
  # REPO_ROOT は取れたのに .git 実体が引けない＝マーカーの場所が決まらない。上と同じ理由で黙って通す。
  exit 0
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

# マーカーが対象リポの現ブランチ名と一致 = dev-ship チェーン内の PR 作成 → 注意書きは出さない
if [ -f "$MARKER" ] && [ -n "$BRANCH" ] && [ "$(tr -d '[:space:]' < "$MARKER")" = "$BRANCH" ]; then
  exit 0
fi

emit_context "[dev-flow] 注意: この PR 作成は /dev-ship を経由していません。explain-diff / hub-run の成果物が未生成かもしれません（PR 作成は止めていません）。
対象リポジトリ: $REPO_ROOT（ブランチ: ${BRANCH:-不明}）
- 未生成なら: PR 作成のあとでも dev-ship スキルの手順で explain-diff と hub-run 登録を行ってください
- すでに生成済みなら（auto-build の Finalize 等）: git -C \"$REPO_ROOT\" branch --show-current > \"$MARKER\" を実行すると、このブランチでは以後この注意書きは出ません"
exit 0
