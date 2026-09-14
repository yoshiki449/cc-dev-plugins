#!/bin/bash
# Stop時に変更ファイルのlint・テストを自動実行するフック
# agent型ではなくcommand型で実行し、結果をstdoutでClaudeに返す

# Stopフックの再帰防止
INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

# プロジェクトディレクトリが不明な場合はスキップ
[ -z "$CLAUDE_PROJECT_DIR" ] && exit 0

cd "$CLAUDE_PROJECT_DIR" || exit 0

# git管理下でなければスキップ
git rev-parse --is-inside-work-tree &>/dev/null || exit 0

# 変更ファイルを取得（unstaged + staged + untracked）
CHANGED=$(git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
CHANGED=$(echo "$CHANGED" | sort -u | grep -v '^$')

[ -z "$CHANGED" ] && exit 0

RESULTS=""
HAS_ERROR=false

# --- Go ファイルのlint ---
GO_FILES=$(echo "$CHANGED" | grep '\.go$' | grep -v '_test\.go$' || true)
if [ -n "$GO_FILES" ]; then
  # Docker内でlint実行を試みる
  # HARNESS_GO_SERVICE: docker-composeのGoバックエンドサービス名に置換してください
  GO_SERVICE="${HARNESS_GO_SERVICE:-backend}"
  CONTAINER=$(docker ps --filter "label=com.docker.compose.service=$GO_SERVICE" --format '{{.Names}}' 2>/dev/null | head -1)
  if [ -n "$CONTAINER" ]; then
    # 変更ファイルに関連するパッケージのみlint
    PACKAGES=$(echo "$GO_FILES" | xargs -I{} dirname {} | sort -u | sed 's|^|./|')
    LINT_OUT=$(docker exec "$CONTAINER" go vet $PACKAGES 2>&1 || true)
    if [ -n "$LINT_OUT" ] && echo "$LINT_OUT" | grep -qv "^$"; then
      RESULTS="$RESULTS\n[Go vet]\n$LINT_OUT"
      HAS_ERROR=true
    fi
  fi
fi

# --- TypeScript/JavaScript ファイルのlint ---
TS_FILES=$(echo "$CHANGED" | grep -E '\.(ts|tsx|js|jsx)$' || true)
if [ -n "$TS_FILES" ]; then
  # ESLintのパスを探す
  ESLINT=""
  for dir in "$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR/frontend"; do
    if [ -f "$dir/node_modules/.bin/eslint" ]; then
      ESLINT="$dir/node_modules/.bin/eslint"
      ESLINT_DIR="$dir"
      break
    fi
  done

  if [ -n "$ESLINT" ]; then
    # 変更ファイルのみlint（存在するファイルのみ）
    LINT_TARGETS=""
    for f in $TS_FILES; do
      FULL="$CLAUDE_PROJECT_DIR/$f"
      [ -f "$FULL" ] && LINT_TARGETS="$LINT_TARGETS $FULL"
    done
    if [ -n "$LINT_TARGETS" ]; then
      LINT_OUT=$(cd "$ESLINT_DIR" && "$ESLINT" --quiet $LINT_TARGETS 2>&1 || true)
      if [ -n "$LINT_OUT" ] && echo "$LINT_OUT" | grep -q "error"; then
        RESULTS="$RESULTS\n[ESLint]\n$(echo "$LINT_OUT" | head -30)"
        HAS_ERROR=true
      fi
    fi
  fi
fi

# --- 変更ファイルに関連するテスト実行 ---
# Go: 変更ファイルに対応する_test.goがあれば実行
GO_TEST_PACKAGES=""
for f in $GO_FILES; do
  TEST_FILE="${f%.go}_test.go"
  if [ -f "$CLAUDE_PROJECT_DIR/$TEST_FILE" ]; then
    PKG=$(dirname "$f")
    GO_TEST_PACKAGES="$GO_TEST_PACKAGES ./$PKG/..."
  fi
done

if [ -n "$GO_TEST_PACKAGES" ] && [ -n "$CONTAINER" ]; then
  GO_TEST_PACKAGES=$(echo "$GO_TEST_PACKAGES" | tr ' ' '\n' | sort -u | tr '\n' ' ')
  TEST_OUT=$(docker exec "$CONTAINER" go test -count=1 -short $GO_TEST_PACKAGES 2>&1 | tail -20 || true)
  if echo "$TEST_OUT" | grep -q "FAIL"; then
    RESULTS="$RESULTS\n[Go Test]\n$TEST_OUT"
    HAS_ERROR=true
  fi
fi

# TypeScript: 変更ファイルに関連するテスト
TS_SRC_FILES=$(echo "$TS_FILES" | grep -v '\.test\.\|\.spec\.\|__tests__' || true)
if [ -n "$TS_SRC_FILES" ]; then
  for dir in "$CLAUDE_PROJECT_DIR" "$CLAUDE_PROJECT_DIR/frontend"; do
    if [ -f "$dir/node_modules/.bin/jest" ]; then
      # 変更ファイル名からテストファイルを推定
      JEST_PATTERNS=""
      for f in $TS_SRC_FILES; do
        BASE=$(basename "$f" | sed 's/\.\(ts\|tsx\)$//')
        JEST_PATTERNS="$JEST_PATTERNS --testPathPattern=$BASE"
      done
      if [ -n "$JEST_PATTERNS" ]; then
        TEST_OUT=$(cd "$dir" && npx jest --passWithNoTests $JEST_PATTERNS 2>&1 | tail -15 || true)
        if echo "$TEST_OUT" | grep -q "FAIL"; then
          RESULTS="$RESULTS\n[Jest]\n$TEST_OUT"
          HAS_ERROR=true
        fi
      fi
      break
    fi
  done
fi

# 結果出力
if [ "$HAS_ERROR" = true ]; then
  echo -e "⚠️ lint/テストで問題が検出されました:\n$RESULTS"
elif [ -n "$CHANGED" ]; then
  echo "✅ 変更ファイルのlint/テスト: 問題なし"
fi

exit 0
