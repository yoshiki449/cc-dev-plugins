#!/usr/bin/env bash
# クラウドセッションの開始時に、.claude/cloud-stack.json を持つリポジトリの軽い準備を始める。
# リポジトリ側に置いた SessionStart hook は、複数リポジトリのセッションでは効かないので plugin が持つ。
# ローカルでは何もしない。失敗してもセッション開始は止めない。
[ "${CLAUDE_CODE_REMOTE:-false}" = "true" ] || exit 0
bash "$(dirname "$0")/../skills/cloud-stack/scripts/cloud-stack.sh" prepare 2>&1 || true
exit 0
