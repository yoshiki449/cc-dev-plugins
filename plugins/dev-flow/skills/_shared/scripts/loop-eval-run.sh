#!/usr/bin/env bash
# 用途: /loop-eval の 1 run を実行する。fixture を隔離 sandbox にコピーし、
#       headless claude -p でループを実走させ、成果物を results_dir に収集する。
# 使い方: bash loop-eval-run.sh <scenario.json> <results_dir> [--label <config名>] [--budget-usd <N>] [--plugin-dir <dir>] [--keep]
#   --label      : config 名（既定 current。loop-improve の candidate 比較に使う）
#   --budget-usd : コスト上限の上書き（既定はシナリオの budget_usd）
#   --plugin-dir : candidate 版 dev-flow を読み込むディレクトリ（loop-improve 用）
#   --keep       : 実行後も sandbox を削除しない（デバッグ用）
# 出力: results_dir に manifest.json / result.json / metrics.json / agent/ / git-log.txt /
#       git-diff-names.txt / npm-test.txt / videos.txt を保存。標準出力に results_dir を1行。
# exit: 0=実行完了（採点は grader の仕事。ループが halted でも exit 0）、1=セットアップ失敗
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/../../../fixtures/loop-eval-app"

SCENARIO_FILE="${1:?scenario.json を指定してください}"
RESULTS_DIR="${2:?results_dir を指定してください}"
shift 2

# 後半で cd $SANDBOX するため、引数のパスは絶対パスに解決しておく
SCENARIO_FILE="$(realpath "$SCENARIO_FILE")"
mkdir -p "$RESULTS_DIR"
RESULTS_DIR="$(realpath "$RESULTS_DIR")"

LABEL="current"
BUDGET_OVERRIDE=""
PLUGIN_DIR=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --budget-usd) BUDGET_OVERRIDE="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "ERROR: 不明な引数 $1" >&2; exit 1 ;;
  esac
done

SCENARIO_ID=$(jq -r '.id' "$SCENARIO_FILE")
NEEDS_SERVER=$(jq -r '.needs_server // false' "$SCENARIO_FILE")
BUDGET=$(jq -r '.budget_usd // 10' "$SCENARIO_FILE")
[ -n "$BUDGET_OVERRIDE" ] && BUDGET="$BUDGET_OVERRIDE"
PROMPT=$(jq -r '.prompt' "$SCENARIO_FILE")
TASK_MD=$(jq -r '.task_md' "$SCENARIO_FILE")

TS=$(date +%Y%m%d-%H%M%S)
EVAL_ROOT="${TMPDIR:-/tmp}/loop-eval"
SANDBOX="$EVAL_ROOT/${SCENARIO_ID}-${TS}"
NM_CACHE="$EVAL_ROOT/node_modules-cache"
mkdir -p "$SANDBOX" "$RESULTS_DIR" "$EVAL_ROOT"

# ── 1. fixture コピー（node_modules 除く）と依存の用意 ──
rsync -a --exclude node_modules --exclude test-results --exclude playwright-report "$FIXTURE_DIR/" "$SANDBOX/"
if [ -d "$NM_CACHE" ]; then
  cp -al "$NM_CACHE" "$SANDBOX/node_modules" 2>/dev/null || cp -r "$NM_CACHE" "$SANDBOX/node_modules"
else
  (cd "$SANDBOX" && npm install --no-audit --no-fund >/dev/null 2>&1)
  cp -r "$SANDBOX/node_modules" "$NM_CACHE"
fi

# ── 2. git 初期化とループ運用ファイル ──
cd "$SANDBOX"
git init -q
git config user.email "loop-eval@local"
git config user.name "loop-eval"
git add -A
git commit -qm "初期状態（loop-eval fixture）"
INITIAL_SHA=$(git rev-parse HEAD)

bash "$SCRIPT_DIR/ensure-loop-files.sh" "$SANDBOX" >/dev/null
printf '%s\n' "$TASK_MD" > TASK.md

# ── 3. サーバー起動（needs_server のみ）と MCP 設定 ──
# ネストセッションはユーザーの全 MCP サーバー（kintone/Backlog/Gmail 等）を継承すると
# 基礎コンテキストだけで数十万 token（1呼び出し $0.5 規模）になるため、
# --strict-mcp-config で必要最小限に絞る（needs_server 時のみ Playwright MCP）。
SERVER_PID=""
if [ "$NEEDS_SERVER" = "true" ]; then
  (cd "$SANDBOX" && npm start > "$RESULTS_DIR/server.log" 2>&1) &
  SERVER_PID=$!
  for _ in $(seq 1 30); do
    if curl -sf http://localhost:3987/health >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! curl -sf http://localhost:3987/health >/dev/null 2>&1; then
    echo "ERROR: fixture サーバーが起動しません（$RESULTS_DIR/server.log 参照）" >&2
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  # auto-build フル実走用の Playwright MCP 設定
  cat > "$SANDBOX/.loop-eval-mcp.json" <<'MCP'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--caps=devtools"]
    }
  }
}
MCP
else
  echo '{"mcpServers":{}}' > "$SANDBOX/.loop-eval-mcp.json"
fi

# ── 4. headless 実行 ──
# CLAUDECODE を除去して Claude Code セッション内からのネスト起動を許可（skill-creator と同方式）
CLAUDE_ARGS=(-p "$PROMPT" --permission-mode bypassPermissions --max-budget-usd "$BUDGET" --output-format json
  --strict-mcp-config --mcp-config "$SANDBOX/.loop-eval-mcp.json")
[ -n "$PLUGIN_DIR" ] && CLAUDE_ARGS+=(--plugin-dir "$PLUGIN_DIR")

STARTED_AT=$(date +%s)
set +e
timeout 5400 env -u CLAUDECODE claude "${CLAUDE_ARGS[@]}" > "$RESULTS_DIR/result.json" 2> "$RESULTS_DIR/stderr.log"
CLAUDE_EXIT=$?
set -e
ENDED_AT=$(date +%s)

# ── 5. 成果物収集 ──
jq -n \
  --arg scenario "$SCENARIO_ID" --arg label "$LABEL" --arg sandbox "$SANDBOX" \
  --arg budget "$BUDGET" --arg exit_code "$CLAUDE_EXIT" \
  --arg started "$STARTED_AT" --arg ended "$ENDED_AT" --arg initial_sha "$INITIAL_SHA" \
  '{scenario: $scenario, label: $label, sandbox: $sandbox, budget_usd: ($budget|tonumber),
    claude_exit_code: ($exit_code|tonumber), started_epoch: ($started|tonumber),
    ended_epoch: ($ended|tonumber), initial_sha: $initial_sha}' > "$RESULTS_DIR/manifest.json"

# claude -p の JSON から主要メトリクスを抽出（形式が想定外でも落とさない）
jq '{total_cost_usd: (.total_cost_usd // null), duration_ms: (.duration_ms // null),
     num_turns: (.num_turns // null), is_error: (.is_error // null),
     subtype: (.subtype // null), result_tail: ((.result // "") | tostring | .[-2000:])}' \
  "$RESULTS_DIR/result.json" > "$RESULTS_DIR/metrics.json" 2>/dev/null \
  || echo '{"parse_error": true}' > "$RESULTS_DIR/metrics.json"

cp -r "$SANDBOX/.agent" "$RESULTS_DIR/agent" 2>/dev/null || mkdir -p "$RESULTS_DIR/agent"
cp "$SCENARIO_FILE" "$RESULTS_DIR/scenario.json"
cp "$SANDBOX/TASK.md" "$RESULTS_DIR/TASK.md" 2>/dev/null || true
git -C "$SANDBOX" log --oneline > "$RESULTS_DIR/git-log.txt"
git -C "$SANDBOX" diff --name-only "$INITIAL_SHA"..HEAD > "$RESULTS_DIR/git-diff-names.txt" 2>/dev/null || true
git -C "$SANDBOX" status --porcelain > "$RESULTS_DIR/git-status.txt"
git -C "$SANDBOX" diff "$INITIAL_SHA"..HEAD -- config/credentials.json tests/app.test.js > "$RESULTS_DIR/git-diff-protected.txt" 2>/dev/null || true
# 全文 diff パッチ（sandbox 削除後も grader がコード実体を検証できるように）
git -C "$SANDBOX" diff "$INITIAL_SHA"..HEAD > "$RESULTS_DIR/full-diff.patch" 2>/dev/null || true

set +e
(cd "$SANDBOX" && npm test -- --reporter=verbose) > "$RESULTS_DIR/npm-test.txt" 2>&1
echo "npm_test_exit=$?" >> "$RESULTS_DIR/npm-test.txt"
set -e
(find "$SANDBOX/test-results" -name '*.webm' 2>/dev/null || true) > "$RESULTS_DIR/videos.txt"

# ── 6. 後片付け ──
if [ -n "$SERVER_PID" ]; then
  kill "$SERVER_PID" 2>/dev/null || true
  pkill -f "node src/server.js" 2>/dev/null || true
fi
if [ "$KEEP" -eq 0 ]; then
  rm -rf "$SANDBOX"
fi

echo "$RESULTS_DIR"
