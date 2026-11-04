#!/usr/bin/env node
'use strict';
// ensure-dockerd.sh のテスト。実行: node --test plugins/dev-flow/hooks/ensure-dockerd.test.js
// 動機: クラウドの VM は docker CLI と dockerd を持つがデーモンは未起動で、cloud-stack.json の無い
// リポジトリでは誰も起こさず、QA が「docker が無い」と読み違えた。偽の docker/dockerd で両方向を固定する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'ensure-dockerd.sh');

function run({ remote, daemonUp }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edd-'));
  const mark = path.join(dir, 'started');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\n${daemonUp ? 'exit 0' : 'exit 1'}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'dockerd'), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
  const env = { PATH: `${dir}:/usr/bin:/bin`, CLAUDE_CODE_REMOTE: remote ? 'true' : 'false' };
  const r = spawnSync('bash', [HOOK], { env, encoding: 'utf8' });
  const t = Date.now();
  while (!fs.existsSync(mark) && Date.now() - t < 1500) spawnSync('sleep', ['0.1']);
  return { status: r.status, started: fs.existsSync(mark) };
}

test('クラウドでデーモンが落ちていれば dockerd を起こす', () => {
  assert.deepStrictEqual(run({ remote: true, daemonUp: false }), { status: 0, started: true });
});
test('デーモンが既に動いていれば何もしない', () => {
  assert.strictEqual(run({ remote: true, daemonUp: true }).started, false);
});
test('ローカルでは何もしない', () => {
  assert.strictEqual(run({ remote: false, daemonUp: false }).started, false);
});
