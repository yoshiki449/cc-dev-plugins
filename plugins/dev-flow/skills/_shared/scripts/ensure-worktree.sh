#!/usr/bin/env bash
# ensure-worktree.sh
#
# dev-flow の worktree 規約チェッカ。
# 各フェーズ（dev-setup / dev-implement / dev-fix）が worktree 内で作業しているかを判定し、
# 状態と推奨アクションを JSON でも人間可読形式でも返す。
#
# 規約（cc-plugins CLAUDE.md 参照）:
#   <project-folder>/
#   ├── repo/                    ← main clone、リモート同期
#   └── worktrees/
#       └── <branch-basename>/   ← worktree（実装・修正はここで行う）
#
# 使い方:
#   bash ensure-worktree.sh                 # 現在の cwd から判定
#   bash ensure-worktree.sh /path/to/dir    # 指定ディレクトリから判定
#   bash ensure-worktree.sh --json          # JSON 出力
#
# 終了コード:
#   0: worktree 内（安全）
#   1: ベースブランチ（main/master/develop 等）上 or フラット repo 上（要移行）
#   2: git repo ではない
#   3: worktree 相当だが規約外のパス（動くが非推奨）
#
# ベースブランチの判定:
#   まず `origin/HEAD` の symbolic-ref（git-flow で develop が既定ブランチのリポ等、
#   clone 時に設定される）を見る。取れなければ main/master/develop を固定候補として見る。
#   これが無いと git-flow 運用（既定ブランチが develop）のリポで「未知のブランチ上」扱いになり、
#   ブランチを切らずに develop 上でそのまま作業→push する経路が生まれる。
#
# 出力する主な情報（人間可読／JSON 共通）:
#   status         : ok | flat_repo | on_main_branch | non_worktree_path | not_a_repo
#   branch         : 現在のブランチ名
#   repo_root      : git rev-parse --show-toplevel の結果
#   project_folder : 規約上の project folder（repo/ の親 or worktrees/<x>/ の 2つ上）
#   worktree_dir   : 規約準拠なら <project_folder>/worktrees/<branch>、非準拠なら空
#   suggestion     : 次にとるべきアクション（自然言語）

set -euo pipefail

TARGET_DIR="${1:-$PWD}"
OUTPUT_JSON=0
if [[ "${1:-}" == "--json" ]]; then
  OUTPUT_JSON=1
  TARGET_DIR="${2:-$PWD}"
elif [[ "${2:-}" == "--json" ]]; then
  OUTPUT_JSON=1
fi

emit() {
  local status="$1"
  local branch="$2"
  local repo_root="$3"
  local project_folder="$4"
  local worktree_dir="$5"
  local suggestion="$6"
  local exit_code="$7"

  if [[ "$OUTPUT_JSON" == "1" ]]; then
    printf '{"status":"%s","branch":"%s","repo_root":"%s","project_folder":"%s","worktree_dir":"%s","suggestion":"%s"}\n' \
      "$status" "$branch" "$repo_root" "$project_folder" "$worktree_dir" "${suggestion//\"/\\\"}"
  else
    echo "status:         $status"
    echo "branch:         $branch"
    echo "repo_root:      $repo_root"
    echo "project_folder: $project_folder"
    echo "worktree_dir:   $worktree_dir"
    echo "suggestion:     $suggestion"
  fi
  exit "$exit_code"
}

cd "$TARGET_DIR" 2>/dev/null || emit "not_a_repo" "" "" "" "" "指定パスが存在しない: $TARGET_DIR" 2

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  emit "not_a_repo" "" "" "" "" "git repo ではない。git init または clone してから再実行" 2
fi

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")

# worktree 判定: git rev-parse --git-dir が .git/worktrees/<name> を含んでいれば worktree
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
IS_WORKTREE=0
case "$GIT_DIR" in
  *"/.git/worktrees/"*|*"/worktrees/"*) IS_WORKTREE=1 ;;
esac

REPO_BASENAME=$(basename "$REPO_ROOT")
REPO_PARENT=$(dirname "$REPO_ROOT")
REPO_PARENT_BASENAME=$(basename "$REPO_PARENT")

# リポジトリの既定ブランチ。origin/HEAD が設定されていればそれを正とする
# （git-flow で develop が既定のリポでも正しく検出できる）。無ければ空のまま
# フォールバック候補（main/master/develop）で判定する。
DETECTED_BASE_BRANCH=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo "")

is_base_branch() {
  local b="$1"
  if [[ -n "$DETECTED_BASE_BRANCH" && "$b" == "$DETECTED_BASE_BRANCH" ]]; then
    return 0
  fi
  case "$b" in
    main|master|develop) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ "$IS_WORKTREE" == "1" ]]; then
  # 規約準拠パスか判定: <project_folder>/worktrees/<branch-basename>
  if [[ "$REPO_PARENT_BASENAME" == "worktrees" ]]; then
    PROJECT_FOLDER=$(dirname "$REPO_PARENT")
    EXPECTED_WORKTREE_NAME=$(echo "${BRANCH}" | sed 's|/|-|g')
    if [[ "$REPO_BASENAME" == "$EXPECTED_WORKTREE_NAME" ]] || [[ "$REPO_BASENAME" == "$BRANCH" ]]; then
      emit "ok" "$BRANCH" "$REPO_ROOT" "$PROJECT_FOLDER" "$REPO_ROOT" \
        "worktree 内・規約準拠。このまま作業してよい" 0
    else
      emit "ok" "$BRANCH" "$REPO_ROOT" "$PROJECT_FOLDER" "$REPO_ROOT" \
        "worktree 内・規約準拠（ディレクトリ名がブランチ名と異なる: $REPO_BASENAME）" 0
    fi
  else
    emit "non_worktree_path" "$BRANCH" "$REPO_ROOT" "" "$REPO_ROOT" \
      "worktree だが規約外パス（<project_folder>/worktrees/<branch>/ ではない）。動作はするが次回は規約準拠パスに揃える推奨" 3
  fi
fi

# ここから main clone 側

# フラット repo 判定: repo_basename が 'repo' でない かつ worktrees/ が兄弟に無い
if [[ "$REPO_BASENAME" == "repo" ]]; then
  PROJECT_FOLDER="$REPO_PARENT"
else
  PROJECT_FOLDER="$REPO_ROOT"
fi

if is_base_branch "$BRANCH"; then
  if [[ "$REPO_BASENAME" == "repo" ]]; then
    SUGGEST="規約準拠の main clone にいる（ベースブランチ: $BRANCH）。実装・修正は worktree（$PROJECT_FOLDER/worktrees/<branch>）で行う。dev-setup を実行して worktree を作成"
  else
    SUGGEST="フラット構成の $BRANCH ブランチ（ベースブランチ）上。dev-setup を実行して (1) 既存 repo を $PROJECT_FOLDER/repo/ に移行 (2) worktree を $PROJECT_FOLDER/worktrees/<branch>/ に作成"
  fi
  emit "on_main_branch" "$BRANCH" "$REPO_ROOT" "$PROJECT_FOLDER" "" "$SUGGEST" 1
fi

# ベースブランチ以外だが worktree ではないケース
if [[ "$REPO_BASENAME" == "repo" ]]; then
  SUGGEST="規約準拠の main clone を非ベースブランチで使用中。worktree を作成して $PROJECT_FOLDER/worktrees/<branch>/ で作業推奨"
else
  SUGGEST="フラット構成で非ベースブランチを使用中。dev-setup で $PROJECT_FOLDER/repo/ に移行し worktree に切り出す推奨"
fi
emit "flat_repo" "$BRANCH" "$REPO_ROOT" "$PROJECT_FOLDER" "" "$SUGGEST" 1
