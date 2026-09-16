#!/usr/bin/env bash
# クラウドセッションの開始時に、.claude/cloud-stack.json を持つリポジトリの軽い準備を始める。
# リポジトリ側に置いた SessionStart hook は、複数リポジトリのセッションでは効かないので plugin が持つ。
# ローカルでは何もしない。失敗してもセッション開始は止めない。
[ "${CLAUDE_CODE_REMOTE:-false}" = "true" ] || exit 0
bash "$(dirname "$0")/../skills/cloud-stack/scripts/cloud-stack.sh" prepare 2>&1 || true
# QC overlay を含む別リポジトリ（cc-plugins 等）をセッションに付けている場合、
# CC_PLUGINS_OVERLAY_SOURCE_SUBPATH が設定されていれば ~/.cc-plugins/overlay/qc/ へ同期する。
# 未設定なら何もしない（互いに独立。片方の失敗がもう片方を止めない）。
bash "$(dirname "$0")/../skills/_shared/scripts/qc-overlay-cloud-sync.sh" 2>&1 || true
exit 0
