#!/usr/bin/env node
'use strict';

// pre-edit-protect.sh（denylist による自動編集ブロック）のテスト。
// 実行: node --test plugins/dev-flow/hooks/pre-edit-protect.test.js
//
// このガードは「ブロックし損ねても何も起きない」種類の失敗をする。
// exit 0 は正常系と無効化の区別がつかないので、denylist のパターン種別ごとに
// 「本当に exit 2 になるか」を明示的に固定する。
//
// BASH_COMPAT を変えて実行するケースは Issue #34 の敵対的検証由来の回帰テスト。
// ${line//\*\*/\*} という畳み込みが bash 4.2 以前で `\*/migrations/\*` を返し、
// / を含む全パターンが一致しなくなってガードが無音で無効化されていた
// （macOS 標準の /bin/bash は 3.2 なので、配布先で現実に踏む）。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'pre-edit-protect.sh');

const DENYLIST = [
  '# コメント行',
  '',
  '.env*',
  '*.pem',
  '**/migrations/**',
  'src/auth/**',
].join('\n');

function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-edit-protect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent', 'loop-denylist.txt'), DENYLIST);
  return dir;
}

// bashCompat を渡すと、その互換モードの bash で実行する。
function runHook(projectDir, relPath, bashCompat) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  if (bashCompat) env.BASH_COMPAT = bashCompat;
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({ cwd: projectDir, tool_input: { file_path: path.join(projectDir, relPath) } }),
    encoding: 'utf8',
    env,
  });
}

function assertBlocked(res, relPath, extra = '') {
  assert.equal(res.status, 2, `'${relPath}' はブロックされるべき${extra}。stderr: ${res.stderr}`);
  assert.match(res.stderr, /denylist 抵触/, 'ブロック理由が stderr に出ていない');
}

function assertAllowed(res, relPath) {
  assert.equal(res.status, 0, `'${relPath}' は許可されるべき。stderr: ${res.stderr}`);
}

// --- パス glob（パターンに / を含む）-----------------------------------------

test('パス glob: **/migrations/** が中間ディレクトリのファイルをブロックする', (t) => {
  const dir = makeProject(t);
  assertBlocked(runHook(dir, 'db/migrations/001_init.sql'), 'db/migrations/001_init.sql');
});

test('パス glob: 先頭一致のパターン src/auth/** をブロックする', (t) => {
  const dir = makeProject(t);
  assertBlocked(runHook(dir, 'src/auth/session.ts'), 'src/auth/session.ts');
});

test('パス glob: トップレベルの migrations/ も **/migrations/** で拾う', (t) => {
  const dir = makeProject(t);
  assertBlocked(runHook(dir, 'migrations/001_init.sql'), 'migrations/001_init.sql');
});

// --- basename glob（パターンに / を含まない）---------------------------------

test('basename glob: .env* が .env.local をブロックする', (t) => {
  const dir = makeProject(t);
  assertBlocked(runHook(dir, 'config/.env.local'), 'config/.env.local');
});

test('basename glob: *.pem をブロックする', (t) => {
  const dir = makeProject(t);
  assertBlocked(runHook(dir, 'certs/server.pem'), 'certs/server.pem');
});

// --- 許可されるべきもの -------------------------------------------------------

test('.env.example は常に許可される（hook 側の固定例外）', (t) => {
  const dir = makeProject(t);
  assertAllowed(runHook(dir, '.env.example'), '.env.example');
});

test('denylist 自身の編集は許可される（人間による見直しを妨げない）', (t) => {
  const dir = makeProject(t);
  assertAllowed(runHook(dir, '.agent/loop-denylist.txt'), '.agent/loop-denylist.txt');
});

test('denylist に無関係なパスは許可される', (t) => {
  const dir = makeProject(t);
  assertAllowed(runHook(dir, 'src/util/helper.ts'), 'src/util/helper.ts');
});

// --- bash の版差に対する回帰テスト（Issue #34 の敵対的検証由来）---------------
// 畳み込みが復活すると、ここだけが落ちて通常実行のテストは全部通る。
// つまりこの2件が「配布先でガードが無音で死ぬ」ことを検出する唯一の網。

for (const compat of ['32', '42']) {
  test(`BASH_COMPAT=${compat} でもパス glob がブロックされる（畳み込み復活の検出）`, (t) => {
    const dir = makeProject(t);
    assertBlocked(
      runHook(dir, 'db/migrations/001_init.sql', compat),
      'db/migrations/001_init.sql',
      `（BASH_COMPAT=${compat}）`,
    );
  });
}
