#!/usr/bin/env bash
# クラウドセッションの開始時に docker デーモンを起こす。
# クラウドの VM には docker CLI と dockerd が入っているが、デーモンは起動済みではない。
# `docker ps` が "failed to connect to the docker API" で落ちるのを、QA が「docker が無い」と
# 読み違える（cloud-stack.json を持たないリポジトリでは cloud-stack が起こさない）ので、
# 先に起こしておく。ローカルでは何もしない。失敗してもセッション開始は止めない。
[ "${CLAUDE_CODE_REMOTE:-false}" = "true" ] || exit 0
command -v docker >/dev/null 2>&1 || exit 0
docker info >/dev/null 2>&1 && exit 0
command -v dockerd >/dev/null 2>&1 || exit 0
mkdir -p /tmp/dev-flow 2>/dev/null
# 9>&- : 親のロック fd を dockerd に引き継がせない（cloud-stack.sh と同じ理由）
(nohup dockerd 9>&- >> /tmp/dev-flow/dockerd.log 2>&1 &)
exit 0
