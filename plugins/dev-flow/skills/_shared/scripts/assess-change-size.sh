#!/usr/bin/env bash
# assess-change-size.sh
#
# 変更規模（S/M/L）×リスク（LOW/HIGH）の2軸で判定し、後続フェーズが使うゲート設定
# （adversarial_lenses / code_reviewer / self_review_members / security_review /
#  test_ledger / explain_diff / qa）をこのスクリプト側で解決しきって JSON で返す。
# qa だけは第3のスコープ軸（frontend / backend）も入力にする（§5.5）。
#
# 判定仕様の正はこのスクリプト本体と skills/_shared/scripts/assess-change-size.test.js。
# conf（.agent/size-tier.conf）の記法と較正の考え方は skills/_shared/reference/size-tier-conf.md。
#
# 使い方:
#   bash assess-change-size.sh [--dir <path>] [--base <ref>] [--head <ref>] [--main-model <id>] [--help]
#
#   --main-model: メインセッションのモデル ID。SELF_VERIFYING_MODELS に一致したときだけ
#   自己検証系のゲートを軽くする（verification_profile: self_verifying）。未指定・不一致は standard。
#
# 終了コード:
#   0: 判定完了（フォールバックを含む）
#   2: 引数エラー・--help
#
# 出力: 常に JSON 1 行を stdout に出す（人間可読モードは持たない）。
# フォールバック時も stdout に JSON を出し exit 0（呼び出し元の set -e を殺さない）。
#
# この判定が誤って軽い方（S / LOW）へ倒れると、レビューが手抜きになったことに誰も
# 気づかない。判定不能・想定外は必ず重い方へ倒し、かつ warnings で音を立てること。

# あえて set -e を使わない。git 呼び出しの失敗はフォールバック分岐で拾う設計であり、
# -e があると失敗した瞬間にスクリプト全体が落ちて JSON を出せなくなる。

# git hook 実行中・rebase --exec 等ではこれらを git 自身が export する。残っていると
# `git -C "$DIR"` が負けて別のリポジトリを判定する（実測: 対象リポの判定が別リポに化ける）。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

DEFAULT_RISK_PATTERNS=(
  "**/auth/**"
  "**/middleware/**"
  "*permission*"
  "*role*"
  "**/api/**"
  "**/routes/**"
  "**/controllers/**"
  "**/migrations/**"
  "**/schema*"
  "**/models/**"
  "*.config.*"
  "Dockerfile"
  "docker-compose*"
  ".github/workflows/**"
  # 秘密の読み込み経路と公開境界。Ansible playbook 一式（**/ansible/**）まで広げると
  # infra リポでは risk がほぼ定数になり「小さい変更が常に重い」を再生産するため入れない。
  # conf での強化（risk: 追加）は無音・緩和は必ず warnings に出る非対称設計なので、
  # IaC 全体を重く見たいリポは各自 .agent/size-tier.conf で足す側に倒す。
  # 基底名形とディレクトリ形の両方を書く。`/` を含まないパターンは基底名だけを見るため
  # `*nginx*` は `roles/nginx/templates/10-app.conf.j2` に当たらず、逆に `**/nginx/**` は
  # ルート直下の `nginx.conf` に当たらない。片方だけだと配置規約次第で無音で効かなくなる。
  "*vault*"
  "**/vault/**"
  "*secret*"
  "**/secrets/**"
  "*credential*"
  "**/credentials/**"
  "*nginx*"
  "**/nginx/**"
  "*.tf"
  "*.tfvars"
)

# スコープ軸（§5.5）。gates.qa（dev-qa のスキップ可否）を決めるためだけに使う。
# サイズ軸・リスク軸は動かさない。判定理由の全文は skills/dev-qa/SKILL.md の概要にある。
#
# 両スコープの判定は frontend と backend の**両方に陽性証拠**があることを要求する。
# 「分類できないなら fail-safe に両方」としないのは、そうするとリスク HIGH のほぼ全変更が
# qa 必須になり、2軸判定を入れた動機（小さい変更が常に重い）を再生産するため。
DEFAULT_FRONTEND_PATTERNS=(
  "*.tsx"
  "*.jsx"
  "*.vue"
  "*.svelte"
  "*.css"
  "*.scss"
  "*.sass"
  "*.less"
  "*.html"
  "**/components/**"
  "**/pages/**"
  "**/views/**"
  "**/layouts/**"
  "**/public/**"
  "**/assets/**"
  "**/styles/**"
  "**/frontend/**"
  "**/client/**"
  # **/templates/** をディレクトリ形パターンとして入れない。infra リポの
  # roles/nginx/templates/10-app.conf.j2 のような**設定テンプレート**まで frontend になると、
  # nginx（リスク HIGH）と組み合わさって qa=required がほぼ定数になる（母集団28件中23件が infra 系）。
  # ただし *.html は上に残してあるので、Django / Flask の templates/login.html は
  # **意図的に frontend として立つ**（HTML テンプレートは表示層そのもので、API と同じ PR に
  # 入っているなら dev-qa が見るべき cross-stack 変更）。infra の .j2 を拾わないのは
  # 「**/templates/** を除外したから」ではなく「.j2 をどちらのパターンにも入れていないから」。
  # この区別は AC36 が固定している（コメントだけで守らない）。
)

DEFAULT_BACKEND_PATTERNS=(
  "**/api/**"
  "**/routes/**"
  "**/controllers/**"
  "**/models/**"
  "**/migrations/**"
  "**/schema*"
  "**/backend/**"
  "**/server/**"
  "**/repositories/**"
  "**/db/**"
  "*.py"
  "*.rb"
  "*.go"
  "*.php"
  "*.java"
  "*.cs"
  "*.rs"
  # **/services/** は入れない。フロントの API クライアント置き場（src/services/userApi.ts）
  # としても一般的で、単独で backend を成立させると SPA 単体リポが両スコープになる。
  # *.ts はどちらにも入れない。フロント・バックの両方で使われるため、片方に寄せた瞬間に
  # 誤判定が量産される。分類しないのが正しい。
  # この2つの帰結として、Node / Nest / Express の backend（src/services/*.ts・server.ts）は
  # **陽性証拠が取れず qa が optional に過少判定される**（既知の穴。契約 §5.5）。
  # 既定を広げるとフロント側で過剰発火するため、該当リポは .agent/size-tier.conf に
  # `backend: src/services/**` を足して補う（追加は強化方向なので警告は出ない）。
)

DEFAULT_EXCLUDE_PATTERNS=(
  "package-lock.json"
  "yarn.lock"
  "pnpm-lock.yaml"
  "composer.lock"
  "Gemfile.lock"
  "poetry.lock"
  "*.min.js"
  "*.min.css"
  "*.map"
  "**/dist/**"
  "**/build/**"
  "**/vendor/**"
  "**/node_modules/**"
)

TEST_FILE_PATTERNS=(
  "*.test.*"
  "*.spec.*"
  "**/tests/**"
  "**/test/**"
  "**/__tests__/**"
)

# S の3本から1本でも外すときは、次の2つを必ず同時に見ること:
#   skills/dev-implement/SKILL.md（Step 3「集約が脱落にならないための前提」）
#   skills/dev-self-review/SKILL.md（「S の3本がこの顔ぶれである理由」）
# 3本の内訳には理由がある:
#   convention             … 規約・命名（他の誰も見ない）
#   requirement-coverage   … dev-ship E1.5c のテスト台帳が coverage.md を入力にするため外せない
#   Code-Reviewer          … S では implement Step 3 の Code-Reviewer が ship に集約されるので、
#                            ここに居ないとバグ・入力検証を見る agent が dev-flow 全体から消える。
#                            simplify-reviewer は禁止事項で「バグ・セキュリティの指摘」を除外して
#                            いるため代替にならない（agents/simplify-reviewer.md の禁止事項節）
SELF_REVIEW_S=(
  "dev-flow:convention-reviewer"
  "dev-flow:requirement-coverage-checker"
  "dev-flow:Code-Reviewer"
)
SELF_REVIEW_ML=(
  "${SELF_REVIEW_S[@]}"
  "dev-flow:simplify-reviewer"
  "dev-flow:codex-cross-reviewer"
)

# メインセッションが自分の作業を検証するモデル。Anthropic の Opus 5 移行ガイドは
# 「頼まれなくても自分で検証するので、検証を指示する足場は過剰検証を招き、削っても能力は落ちない」
# とする。軽くするのは自己検証の重ね掛けだけで、自己検証では代わりにならないものは残す:
#   - adversarial レンズ A（テスト緩和・mock 逃避）: 実装者自身が作った抜け道を別コンテキストで見る
#   - レンズ D / security_review（リスク HIGH）: 領域リスクの専門観点
#   - requirement-coverage-checker: テスト台帳の入力で、落とすと台帳が壊れる
#   - Code-Reviewer: ship に1回は必ず居させる（S と同じ理由）
#   - codex-cross-reviewer（M・L）: 別ベンダーのモデルによる独立の視点
# 一致しないモデル（Sonnet / Codex 等）は、メインの自己検証を当てにできないので従来どおり。
# 追加するときは、そのモデルの移行ガイドで自己検証の挙動を確かめてからにする。
SELF_VERIFYING_MODELS=(
  "claude-opus-5"
  "claude-fable-5"
  "claude-fable-5-1"
)
SELF_REVIEW_S_SELF_VERIFYING=(
  "dev-flow:requirement-coverage-checker"
  "dev-flow:Code-Reviewer"
)
SELF_REVIEW_ML_SELF_VERIFYING=(
  "${SELF_REVIEW_S_SELF_VERIFYING[@]}"
  "dev-flow:codex-cross-reviewer"
)

DEFAULT_THRESHOLD_M=100
DEFAULT_THRESHOLD_L=500

print_usage() {
  cat >&2 <<'EOF'
使い方: assess-change-size.sh [--dir <path>] [--base <ref>] [--head <ref>] [--main-model <id>] [--help]

--main-model にはメインセッションのモデル ID を渡す（形は claude-<モデル名>[1m] のようになる）。
自己検証するモデルのときだけ検証ゲートが軽くなり、未指定なら従来どおり。

プロジェクト固有の較正は .agent/size-tier.conf に書く。
記法（threshold_m= / threshold_l= / risk: / exclude: / frontend: / backend: / *_reset）と
較正の考え方は dev-flow plugin 内の skills/_shared/reference/size-tier-conf.md を参照。
EOF
}

# 先頭・末尾の空白（タブ含む）を落とす。conf の "risk: src/x/**" のような
# コロン後の空白揺れを吸収するために必要。
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# \ " と U+0000-U+001F の制御文字を JSON エスケープする（\b \f \n \r \t は短縮形）。
# 制御文字を素通りさせると出力が JSON として壊れ、しかも exit 0 で壊れた JSON が出る
# ため §7 の fail-safe が効かない領域になる（§2.1）。
json_escape() {
  local s="$1"
  case "$s" in
    *[\\\"$'\x01'-$'\x1f']*) ;;
    *) printf '%s' "$s"; return ;;
  esac
  local out="" i len c next
  len=${#s}
  for (( i = 0; i < len; i++ )); do
    c="${s:i:1}"
    case "$c" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\b') out+='\b' ;;
      $'\t') out+='\t' ;;
      $'\n') out+='\n' ;;
      $'\f') out+='\f' ;;
      $'\r') out+='\r' ;;
      *)
        printf -v next '%d' "'$c"
        if (( next >= 0 && next <= 31 )); then
          printf -v out '%s\u%04x' "$out" "$next"
        else
          out+="$c"
        fi
        ;;
    esac
  done
  printf '%s' "$out"
}

json_array() {
  local out="[" first=1 elem
  for elem in "$@"; do
    if [[ $first -eq 1 ]]; then first=0; else out+=","; fi
    out+="\"$(json_escape "$elem")\""
  done
  out+="]"
  printf '%s' "$out"
}

# git diff --numstat が返すパス文字列を実パスに戻す。制御文字・バックスラッシュ・
# ダブルクォートを含むパスは core.quotepath の設定に関わらず常に "..." でクォート
# されるため（-c core.quotepath=false は高バイトのみを対象外にする）、タブ等を
# 含むパスは生のまま TAB 区切りで読んでも中身がエスケープ済み文字列のままになる（AC23）。
git_dequote_path() {
  local raw="$1"
  case "$raw" in
    \"*\") ;;
    *) printf '%s' "$raw"; return ;;
  esac
  local body="${raw#\"}"
  body="${body%\"}"
  local out="" i=0 len=${#body} c next oct
  while (( i < len )); do
    c="${body:i:1}"
    if [[ "$c" == '\' ]]; then
      next="${body:i+1:1}"
      case "$next" in
        a) out+=$'\a'; i=$((i + 2)) ;;
        b) out+=$'\b'; i=$((i + 2)) ;;
        t) out+=$'\t'; i=$((i + 2)) ;;
        n) out+=$'\n'; i=$((i + 2)) ;;
        v) out+=$'\v'; i=$((i + 2)) ;;
        f) out+=$'\f'; i=$((i + 2)) ;;
        r) out+=$'\r'; i=$((i + 2)) ;;
        '\') out+='\'; i=$((i + 2)) ;;
        '"') out+='"'; i=$((i + 2)) ;;
        [0-7])
          oct="${body:i+1:3}"
          out+="$(printf "\\${oct}")"
          i=$((i + 4))
          ;;
        *) out+="$next"; i=$((i + 2)) ;;
      esac
    else
      out+="$c"
      i=$((i + 1))
    fi
  done
  printf '%s' "$out"
}

# リスク軸（§5）とスコープ軸（§5.5）の照合はケース非依存にする（src/Auth/ src/Api/ のような
# .NET/Java 系の命名を拾うため。§5 実測）。どちらも過剰マッチは重い側（HIGH / qa=required）へ
# 倒れるので安全側。shopt は関数を抜ける前に必ず明示的に off へ戻す
# （呼び出し元の BASHOPTS に依存させない・スコープ外に波及させない）。
# ** を * に畳む前処理はしない: ${pat//\*\*/\*} は bash 4.2 以前で置換後に
# バックスラッシュが残り \*/api/\* になって / を含む全パターンの照合が死ぬ
# （macOS 標準 bash 3.2 で発火。畳み込み自体が不要 — [[ == ]] の * は元々 / を跨ぐ）。
path_matches_risk() {
  local rel="$1" pat="$2" result=1
  shopt -s nocasematch
  if [[ "$pat" == */* ]]; then
    [[ "$rel" == $pat || "/$rel" == $pat ]] && result=0
  else
    local base="${rel##*/}"
    [[ "$base" == $pat ]] && result=0
  fi
  shopt -u nocasematch
  return $result
}

# 除外パターン・テストファイル判定はケース依存のまま（AC20: nocasematch を
# リスク照合の外に漏らさない）。
path_matches_plain() {
  local rel="$1" pat="$2"
  if [[ "$pat" == */* ]]; then
    [[ "$rel" == $pat || "/$rel" == $pat ]]
  else
    local base="${rel##*/}"
    [[ "$base" == $pat ]]
  fi
}

path_matches_any_risk() {
  local rel="$1"
  shift
  local pat
  for pat in "$@"; do
    path_matches_risk "$rel" "$pat" && return 0
  done
  return 1
}

path_matches_any_plain() {
  local rel="$1"
  shift
  local pat
  for pat in "$@"; do
    path_matches_plain "$rel" "$pat" && return 0
  done
  return 1
}

# .agent/size-tier.conf の読み込み。RISK_PATTERNS / EXCLUDE_PATTERNS / THRESHOLD_M /
# THRESHOLD_L / WARNINGS を確定させる。symlink・ディレクトリ・読み取り不可・64KB超は
# 読まずに既定値へ退避する（symlink は PR 経由でリポジトリ外ファイルへのリンクを
# 送り込めるため、中身を一切読まない。§3.1 実測: 疑似トークンが warnings 経由で
# 出力に漏れることを確認済み）。200行を超えた分は打ち切る（無制限だと巨大 conf で
# ハングし「フォールバック時も必ず JSON を出す」契約の中核が破れる。実測: 60秒超・出力0バイト）。
# tracked な較正テンプレートの置き場所。判定器はこのパスを「較正が意図されているリポか」の
# 判別にだけ使い、中身は読まない（読むと .agent/size-tier.conf の symlink 拒否と同じ
# リポジトリ外参照の穴が tracked 側に開く）。
CONF_TEMPLATE_PATH="docs/testing/size-tier.conf.template"

load_conf() {
  local root="$1"
  local conf="$root/.agent/size-tier.conf"

  WARNINGS=()
  THRESHOLD_M=$DEFAULT_THRESHOLD_M
  THRESHOLD_L=$DEFAULT_THRESHOLD_L
  RISK_PATTERNS=("${DEFAULT_RISK_PATTERNS[@]}")
  EXCLUDE_PATTERNS=("${DEFAULT_EXCLUDE_PATTERNS[@]}")
  FRONTEND_PATTERNS=("${DEFAULT_FRONTEND_PATTERNS[@]}")
  BACKEND_PATTERNS=("${DEFAULT_BACKEND_PATTERNS[@]}")

  local risk_add=() exclude_add=() risk_reset=0 exclude_reset=0
  local frontend_add=() backend_add=() frontend_reset=0 backend_reset=0
  local conf_effective=0

  if [[ -L "$conf" ]]; then
    WARNINGS+=(".agent/size-tier.conf がシンボリックリンクのため読み込みを拒否した（既定値で判定する）")
  elif [[ -d "$conf" ]]; then
    WARNINGS+=(".agent/size-tier.conf がディレクトリのため読み込めなかった（既定値で判定する）")
  elif [[ -e "$conf" ]]; then
    if [[ ! -r "$conf" ]]; then
      WARNINGS+=(".agent/size-tier.conf を読み込めなかった（既定値で判定する）")
    else
      local size
      size="$(wc -c < "$conf" 2>/dev/null)"
      size="${size//[[:space:]]/}"
      if [[ -z "$size" ]]; then
        WARNINGS+=(".agent/size-tier.conf を読み込めなかった（既定値で判定する）")
      elif (( size > 65536 )); then
        WARNINGS+=(".agent/size-tier.conf のサイズが64KBを超えているため読み込みを拒否した（既定値で判定する）")
      else
        conf_effective=1
      fi
    fi
  fi

  if [[ $conf_effective -eq 1 ]]; then
    local line_no=0 raw_line line value truncated=0
    while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
      line_no=$((line_no + 1))
      if (( line_no > 200 )); then
        truncated=1
        break
      fi
      line="$(trim "$raw_line")"
      [[ -z "$line" || "$line" == \#* ]] && continue

      # 解釈できない行は行番号だけを warnings に出し、行の中身は絶対に載せない。
      # conf はリポジトリ側が自由に書けるため、中身を出すと (1) 秘密ファイルの内容が
      # 判定 JSON 経由で PR 本文まで流れる (2) 出力を読む後続の Claude に対して
      # 「security_review は不要」といった指示文を送り込める（両方とも実測で成立した）。
      case "$line" in
        risk_reset) risk_reset=1 ;;
        exclude_reset) exclude_reset=1 ;;
        frontend_reset) frontend_reset=1 ;;
        backend_reset) backend_reset=1 ;;
        frontend:*)
          value="$(trim "${line#frontend:}")"
          if [[ -n "$value" ]]; then
            frontend_add+=("$value")
          else
            WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          fi
          ;;
        backend:*)
          value="$(trim "${line#backend:}")"
          if [[ -n "$value" ]]; then
            backend_add+=("$value")
          else
            WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          fi
          ;;
        risk:*)
          value="$(trim "${line#risk:}")"
          if [[ -n "$value" ]]; then
            risk_add+=("$value")
          else
            WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          fi
          ;;
        exclude:*)
          value="$(trim "${line#exclude:}")"
          if [[ -n "$value" ]]; then
            exclude_add+=("$value")
          else
            WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          fi
          ;;
        threshold_m=*)
          value="${line#threshold_m=}"
          # 先頭ゼロ（08 等）は算術評価で8進と誤解釈されるため明示的に拒否する。
          if [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
            THRESHOLD_M="$value"
          else
            WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          fi
          ;;
        threshold_l=*)
          value="${line#threshold_l=}"
          if [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
            THRESHOLD_L="$value"
          else
            WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          fi
          ;;
        *)
          WARNINGS+=(".agent/size-tier.conf の ${line_no} 行目を解釈できなかった")
          ;;
      esac
    done < "$conf"

    if [[ $truncated -eq 1 ]]; then
      WARNINGS+=(".agent/size-tier.conf が200行を超えているため、201行目以降を無視した")
    fi

    # threshold_m > threshold_l は M 帯を丸ごと消す矛盾なので、個別行の妥当性とは
    # 別に事後検証する（両方とも構文的には正しい整数でも組み合わせが無効なため）。
    if (( THRESHOLD_M > THRESHOLD_L )); then
      THRESHOLD_M=$DEFAULT_THRESHOLD_M
      THRESHOLD_L=$DEFAULT_THRESHOLD_L
      WARNINGS+=(".agent/size-tier.conf の threshold_m が threshold_l を超える矛盾があるため、両方とも既定値に戻した")
    fi
  fi

  if [[ $risk_reset -eq 1 ]]; then
    RISK_PATTERNS=("${risk_add[@]}")
  else
    RISK_PATTERNS=("${DEFAULT_RISK_PATTERNS[@]}" "${risk_add[@]}")
  fi
  if [[ $exclude_reset -eq 1 ]]; then
    EXCLUDE_PATTERNS=("${exclude_add[@]}")
  else
    EXCLUDE_PATTERNS=("${DEFAULT_EXCLUDE_PATTERNS[@]}" "${exclude_add[@]}")
  fi
  if [[ $frontend_reset -eq 1 ]]; then
    FRONTEND_PATTERNS=("${frontend_add[@]}")
  else
    FRONTEND_PATTERNS=("${DEFAULT_FRONTEND_PATTERNS[@]}" "${frontend_add[@]}")
  fi
  if [[ $backend_reset -eq 1 ]]; then
    BACKEND_PATTERNS=("${backend_add[@]}")
  else
    BACKEND_PATTERNS=("${DEFAULT_BACKEND_PATTERNS[@]}" "${backend_add[@]}")
  fi

  # 「較正が意図されているのに効いていない」を検出する。
  # ここに置くのは、判定材料が conf のパース結果（reset / add / 閾値）だから。
  #
  # ⚠ 判定材料は「conf を読み込めたか（conf_effective）」ではなく
  #    **設定が1つでも適用されたか（conf_applied）**。理由は実測に基づく:
  #    `*.template` は雛形なので **コメントだけ・空** で配布されるのが自然で、
  #    dev-setup B1-3.5 がそれをそのまま cp すると conf_effective=1 になり
  #    **警告が消える**。本機構の正規の運用フロー（テンプレートを配ってコピーさせる）が
  #    そのまま警告を無音にしてしまう。
  #
  #    「ファイルはあるが中身が空」と「ファイルが無い」は、較正が効いていない点で等価で
  #    判定結果も既定値で一致する。両方とも鳴らす。
  local conf_applied=0
  if [[ $conf_effective -eq 1 ]]; then
    if (( THRESHOLD_M != DEFAULT_THRESHOLD_M )) || (( THRESHOLD_L != DEFAULT_THRESHOLD_L )) ||
       (( ${#risk_add[@]} > 0 )) || (( ${#exclude_add[@]} > 0 )) ||
       (( ${#frontend_add[@]} > 0 )) || (( ${#backend_add[@]} > 0 )) ||
       (( risk_reset == 1 )) || (( exclude_reset == 1 )) ||
       (( frontend_reset == 1 )) || (( backend_reset == 1 )); then
      conf_applied=1
    fi
  fi

  if [[ $conf_applied -eq 0 && -f "$root/$CONF_TEMPLATE_PATH" ]]; then
    # 状態を書き分ける。「conf が無い」と「conf はあるが空」では次にやることが違い、
    # 一律に dev-setup B1-3.5 へ誘導すると、後者では B1-3.5 が no-op（conf があるので
    # コピーしない）なので、戻ってきても何も起きないデッドエンドになる。
    if [[ $conf_effective -eq 1 ]]; then
      WARNINGS+=(".agent/size-tier.conf に有効な設定が1行も無い（$CONF_TEMPLATE_PATH をコピーしただけの状態。閾値・risk/exclude パターンを実際に書くまで較正は効かない）")
    else
      WARNINGS+=("$CONF_TEMPLATE_PATH があるのに .agent/size-tier.conf が有効でない（このリポの較正が効いていない。worktree なら dev-setup B1-3.5 のコピーが漏れている）")
    fi
  fi

  # §3.1: 「diff に現れたか」ではなく「今読み込んだ conf が既定を緩めているか」で
  # 判定する（.agent/ は規約で gitignore されるため diff ベースの警告は原理的に
  # 一度も鳴らない。実測済み）。厳しくする方向（risk: 追加・閾値の引き下げ）は
  # オオカミ少年を避けるため無音のままにする。
  if [[ $conf_effective -eq 1 ]]; then
    local loosened=0 reasons=()
    [[ $risk_reset -eq 1 ]] && { loosened=1; reasons+=("risk_reset"); }
    [[ $exclude_reset -eq 1 ]] && { loosened=1; reasons+=("exclude_reset"); }
    [[ ${#exclude_add[@]} -gt 0 ]] && { loosened=1; reasons+=("exclude追加"); }
    # 既定のスコープパターンを捨てると両スコープが成立せず gates.qa の required が消える。
    # frontend: / backend: の追加は分類を増やす＝強化方向なので無音でよい。
    [[ $frontend_reset -eq 1 ]] && { loosened=1; reasons+=("frontend_reset"); }
    [[ $backend_reset -eq 1 ]] && { loosened=1; reasons+=("backend_reset"); }
    (( THRESHOLD_M > DEFAULT_THRESHOLD_M )) && { loosened=1; reasons+=("threshold_m引き上げ"); }
    (( THRESHOLD_L > DEFAULT_THRESHOLD_L )) && { loosened=1; reasons+=("threshold_l引き上げ"); }
    if [[ $loosened -eq 1 ]]; then
      local reason_str
      reason_str="$(IFS=,; echo "${reasons[*]}")"
      WARNINGS+=("判定設定 .agent/size-tier.conf が既定を緩めている（${reason_str}）。ゲートが意図せず軽くなっていないか人手で確認すること")
    fi
  fi
}

# git diff --numstat を1回読み、files/lines/matched_risk_paths/excluded_paths/
# テストファイル変更有無を diff の出現順を保ったまま集計する。
# リスク照合は除外を適用せず全パスに対して行う（除外をリスクにも効かせると
# conf 次第で HIGH が無音で消える）。
parse_diff() {
  FILES_N=0
  LINES_TOTAL=0
  MATCHED_RISK_PATHS=()
  EXCLUDED_PATHS=()
  HAS_TEST_FILE=0
  HAS_FRONTEND=0
  HAS_BACKEND=0

  [[ -z "$DIFF_OUTPUT" ]] && return

  local added deleted filepath file_lines
  while IFS=$'\t' read -r added deleted filepath; do
    [[ -z "$filepath" ]] && continue
    filepath="$(git_dequote_path "$filepath")"

    # 自分自身の設定ファイルは判定対象の「変更コード」ではない。数えてしまうと
    # 閾値を調整する行為そのものがサイズを押し上げる自己参照になる。
    # ここは §3.1 の state ベース警告とは無関係（黙って除外するだけでよい。
    # 警告は load_conf 側で今の内容を見て判定済み）。
    if [[ "$filepath" == ".agent/size-tier.conf" ]]; then
      continue
    fi
    FILES_N=$((FILES_N + 1))

    # binary 行は numstat が "-" を返す。行数0だが files には数える。
    file_lines=0
    if [[ "$added" != "-" && "$deleted" != "-" ]]; then
      file_lines=$((added + deleted))
    fi

    if path_matches_any_risk "$filepath" "${RISK_PATTERNS[@]}"; then
      MATCHED_RISK_PATHS+=("$filepath")
    fi

    # スコープ照合も除外を適用しない（リスク照合と同じ理由）。除外を効かせると
    # conf に `exclude: **/*.tsx` を1行足すだけで frontend スコープが消え、
    # gates.qa が required → optional に**無音で**落ちる。§5.5 実測。
    if [[ $HAS_FRONTEND -eq 0 ]] && path_matches_any_risk "$filepath" "${FRONTEND_PATTERNS[@]}"; then
      HAS_FRONTEND=1
    fi
    if [[ $HAS_BACKEND -eq 0 ]] && path_matches_any_risk "$filepath" "${BACKEND_PATTERNS[@]}"; then
      HAS_BACKEND=1
    fi

    if path_matches_any_plain "$filepath" "${EXCLUDE_PATTERNS[@]}"; then
      EXCLUDED_PATHS+=("$filepath")
    else
      LINES_TOTAL=$((LINES_TOTAL + file_lines))
    fi

    if [[ $HAS_TEST_FILE -eq 0 ]] && path_matches_any_plain "$filepath" "${TEST_FILE_PATTERNS[@]}"; then
      HAS_TEST_FILE=1
    fi
  done <<< "$DIFF_OUTPUT"
}

compute_size() {
  if (( LINES_TOTAL < THRESHOLD_M )); then
    SIZE="S"
  elif (( LINES_TOTAL <= THRESHOLD_L )); then
    SIZE="M"
  else
    SIZE="L"
  fi
}

compute_risk() {
  if [[ ${#MATCHED_RISK_PATHS[@]} -gt 0 ]]; then
    RISK="HIGH"
  else
    RISK="LOW"
  fi
}

# 検出できたスコープだけを ["frontend","backend"] の固定順で並べる（§2）。
compute_scopes() {
  SCOPES=()
  [[ $HAS_FRONTEND -eq 1 ]] && SCOPES+=("frontend")
  [[ $HAS_BACKEND -eq 1 ]] && SCOPES+=("backend")
  return 0
}

# gates はここで解決しきる（SKILL.md 側に条件分岐を残さない）。§6 の表そのもの。
resolve_gates() {
  local size="$1" risk="$2" has_test_file="$3" both_scopes="$4"

  case "$size" in
    S)
      LENSES=(A)
      CODE_REVIEWER="ship"
      SELF_MEMBERS=("${SELF_REVIEW_S[@]}")
      if [[ "$has_test_file" == "1" ]]; then
        TEST_LEDGER="post_pr"
      else
        TEST_LEDGER="skip"
      fi
      ;;
    M)
      LENSES=(A B)
      CODE_REVIEWER="ship"
      SELF_MEMBERS=("${SELF_REVIEW_ML[@]}")
      TEST_LEDGER="post_pr"
      ;;
    L)
      LENSES=(A B C)
      CODE_REVIEWER="per_phase"
      SELF_MEMBERS=("${SELF_REVIEW_ML[@]}")
      TEST_LEDGER="pre_pr"
      ;;
  esac

  if [[ "$PROFILE" == "self_verifying" ]]; then
    LENSES=(A)
    CODE_REVIEWER="ship"
    if [[ "$size" == "S" ]]; then
      SELF_MEMBERS=("${SELF_REVIEW_S_SELF_VERIFYING[@]}")
    else
      SELF_MEMBERS=("${SELF_REVIEW_ML_SELF_VERIFYING[@]}")
    fi
  fi

  if [[ "$risk" == "HIGH" ]]; then
    LENSES+=(D)
    SECURITY_REVIEW="true"
  else
    SECURITY_REVIEW="false"
  fi

  EXPLAIN_DIFF="post_pr"

  # dev-qa のスキップ可否（§5.5・サイズ軸とは独立）。リスク HIGH かつ frontend + backend の
  # 両スコープのときだけ required にする。**なぜ qa が catch layer なのかの全文は
  # skills/dev-qa/SKILL.md の概要にあり、ここには書かない**（同じ WHY を3箇所で保守しない）。
  # 強制点は dev-ship の E0.7 だけ（経路選択時点では差分が無く lines:0 ＝最軽量判定になるので、
  # /dev ルーターでは判定を採用できない）。
  if [[ "$risk" == "HIGH" && "$both_scopes" == "1" ]]; then
    QA="required"
  else
    QA="optional"
  fi
}

# base 側の自動検出。§4 の4候補をこの順で試す。全滅したら呼び出し元がフォールバックする。
resolve_base() {
  local root="$1" head_ref="$2" candidate mb
  local candidates=("origin/main" "main" "origin/master" "master")
  for candidate in "${candidates[@]}"; do
    mb="$(git -C "$root" merge-base "$head_ref" "$candidate" 2>/dev/null)"
    if [[ $? -eq 0 && -n "$mb" ]]; then
      printf '%s' "$mb"
      return 0
    fi
  done
  return 1
}

# --base/--head が実在するコミットに解決できることを確認する。空文字列も弾く
# （"" のまま git diff に渡すと "HEAD...HEAD" 相当になり「差分ゼロ」と誤解釈される）。
# --end-of-options を付けるのは「たまたま git が --output= 等を弾いてくれている」
# 状態に依存しないため（§3 の diff 呼び出しと同じ基準。git 2.24+ を前提にする制約は
# §3 で既に発生しているので、ここで新たに増えるわけではない）。
verify_ref() {
  local root="$1" ref="$2"
  [[ -z "$ref" ]] && return 1
  git -C "$root" rev-parse --verify --quiet --end-of-options "${ref}^{commit}" >/dev/null 2>&1
}

# 上限20件。超えたら先頭20件+要約1件にする。巨大 conf 由来で警告が青天井に
# 増えると O(n^2) の文字列連結と合わさって判定器自体がハングする（実測: 60秒超）。
truncate_warnings() {
  local n=${#WARNINGS[@]}
  if (( n > 20 )); then
    local omitted=$(( n - 20 ))
    WARNINGS=("${WARNINGS[@]:0:20}")
    WARNINGS+=("他 ${omitted} 件の警告を省略した")
  fi
}

print_json() {
  truncate_warnings
  local out="{"
  out+="\"size\":\"$(json_escape "$SIZE")\","
  out+="\"risk\":\"$(json_escape "$RISK")\","
  out+="\"lines\":$LINES_TOTAL,"
  out+="\"files\":$FILES_N,"
  out+="\"matched_risk_paths\":$(json_array "${MATCHED_RISK_PATHS[@]}"),"
  out+="\"excluded_paths\":$(json_array "${EXCLUDED_PATHS[@]}"),"
  out+="\"scopes\":$(json_array "${SCOPES[@]}"),"
  out+="\"fallback\":$FALLBACK,"
  out+="\"fallback_reason\":\"$(json_escape "$FALLBACK_REASON")\","
  out+="\"warnings\":$(json_array "${WARNINGS[@]}"),"
  out+="\"main_model\":\"$(json_escape "$MAIN_MODEL")\","
  out+="\"verification_profile\":\"$(json_escape "$PROFILE")\","
  out+="\"gates\":{"
  out+="\"adversarial_lenses\":$(json_array "${LENSES[@]}"),"
  out+="\"code_reviewer\":\"$(json_escape "$CODE_REVIEWER")\","
  out+="\"self_review_members\":$(json_array "${SELF_MEMBERS[@]}"),"
  out+="\"security_review\":$SECURITY_REVIEW,"
  out+="\"test_ledger\":\"$(json_escape "$TEST_LEDGER")\","
  out+="\"explain_diff\":\"$(json_escape "$EXPLAIN_DIFF")\","
  out+="\"qa\":\"$(json_escape "$QA")\""
  out+="}}"
  printf '%s\n' "$out"
}

# フォールバック（§7）: L×HIGH 固定で JSON を stdout に出し exit 0。
# WARNINGS はリセットしない（load_conf 済みなら §8/§3.1 の警告を保持したまま出す）。
fallback() {
  local reason="$1"
  SIZE="L"; RISK="HIGH"; LINES_TOTAL=0; FILES_N=0
  MATCHED_RISK_PATHS=(); EXCLUDED_PATHS=(); SCOPES=()
  FALLBACK="true"; FALLBACK_REASON="$reason"
  # 判定できないときは重い側に倒す原則を、モデルによる軽量化より優先する
  PROFILE="standard"
  # 第4引数（both_scopes）に 1 を渡して qa を required に固定する。scopes は [] のままだが、
  # これは matched_risk_paths が [] のまま risk:"HIGH" になる既存の形と同じ
  # （証拠が取れないから重い側に倒す）。
  resolve_gates "$SIZE" "$RISK" 0 1
  print_json
  exit 0
}

DIR="$PWD"
BASE=""
HEAD_REF="HEAD"
BASE_SET=0
HEAD_SET=0
MAIN_MODEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      DIR="$2"; shift 2 ;;
    --base)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      BASE="$2"; BASE_SET=1; shift 2 ;;
    --head)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      HEAD_REF="$2"; HEAD_SET=1; shift 2 ;;
    --main-model)
      [[ $# -lt 2 ]] && { print_usage; exit 2; }
      MAIN_MODEL="$2"; shift 2 ;;
    --help)
      print_usage; exit 2 ;;
    *)
      print_usage; exit 2 ;;
  esac
done

# Claude Code のモデル ID は "claude-opus-5[1m]" のようにコンテキスト長の注記が付くので落とす。
# 大文字小文字の揺れも吸収するが、前方一致にはしない（未知の派生モデルを勝手に軽くしない）。
MAIN_MODEL="$(trim "${MAIN_MODEL%%\[*}")"
MAIN_MODEL="${MAIN_MODEL,,}"
PROFILE="standard"
for m in "${SELF_VERIFYING_MODELS[@]}"; do
  [[ "$MAIN_MODEL" == "$m" ]] && PROFILE="self_verifying"
done

FALLBACK="false"
FALLBACK_REASON=""
WARNINGS=()

[[ -d "$DIR" ]] || fallback "指定ディレクトリが存在しない: $DIR"

git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fallback "git リポジトリではない"

# サブディレクトリを渡された場合や cwd がサブディレクトリの場合でも、conf 探索と
# diff のパス基準を常にリポジトリルートに統一する（座標系のズレで conf が丸ごと
# 無視される事故を防ぐ。§1 実測）。
ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"
[[ -n "$ROOT" ]] || fallback "git リポジトリではない"

# フォールバックしても §8/§3.1 の警告を保持するため、ref 解決より先に読む。
load_conf "$ROOT"

if [[ $HEAD_SET -eq 1 ]]; then
  verify_ref "$ROOT" "$HEAD_REF" || fallback "指定された ref を解決できない（--head）"
fi

if [[ $BASE_SET -eq 1 ]]; then
  verify_ref "$ROOT" "$BASE" || fallback "指定された ref を解決できない（--base）"
else
  BASE="$(resolve_base "$ROOT" "$HEAD_REF")"
  [[ $? -eq 0 ]] || fallback "比較元 ref を解決できない（main/master が見つからない）"
fi

# 4つのオプションはいずれも外すと判定が軽い方へ倒れる（実測）。
#   core.quotepath=false : 非 ASCII パスが8進エスケープされ、リスクにも除外にも一致しなくなる
#   diff.relative=false  : diff.relative=true のリポでパス基準がずれる（ROOT 実行に依存しない保険）
#   --no-renames         : rename が src/{lib => auth}/x.ts の合成表記になり /auth/ を含まなくなる
#   --end-of-options     : --base に --output= 等を渡すとオプションとして解釈され、
#                          任意パスへの書き込みと「変更なし」判定が同時に起きる
DIFF_OUTPUT="$(git -C "$ROOT" -c core.quotepath=false -c diff.relative=false diff --numstat --no-renames --end-of-options "${BASE}...${HEAD_REF}" -- 2>/dev/null)"
DIFF_RC=$?
[[ $DIFF_RC -eq 0 ]] || fallback "diff の取得に失敗した"

parse_diff
compute_size
compute_risk
compute_scopes
BOTH_SCOPES=0
[[ $HAS_FRONTEND -eq 1 && $HAS_BACKEND -eq 1 ]] && BOTH_SCOPES=1
resolve_gates "$SIZE" "$RISK" "$HAS_TEST_FILE" "$BOTH_SCOPES"
print_json
exit 0
