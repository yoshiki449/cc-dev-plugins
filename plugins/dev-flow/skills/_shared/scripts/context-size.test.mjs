// context-size.mjs のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/context-size.test.mjs
//
// フェーズ区切りで「/clear を促すか」を決める値なので、外すと黙って促さなくなる方向が危ない。
// 特にサブエージェントの行（isSidechain）を拾うと、親が 900K でもサブの 60K を返して
// 「閾値未満」になる。同じ jsonl に両方が混ざる形の fixture で固定する。

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./context-size.mjs', import.meta.url));
const SID = '11111111-2222-3333-4444-555555555555';

const usage = (input, write, read, output = 10) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: output,
});
const assistant = (u, extra = {}) =>
  JSON.stringify({ type: 'assistant', requestId: extra.requestId || 'req', message: { usage: u }, ...extra });

/** 一時の設定ディレクトリに projects/<proj>/<sid>.jsonl を置く。 */
function fixture(lines, { sid = SID, proj = '-home-user-repo' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-size-'));
  if (lines) {
    fs.mkdirSync(path.join(dir, 'projects', proj), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', proj, `${sid}.jsonl`), lines.join('\n') + '\n');
  }
  return dir;
}

function run(configDir, { sid = SID, args = [] } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (sid) env.CLAUDE_CODE_SESSION_ID = sid;
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `exit 0 のはず: ${r.stderr}`);
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, 1, `JSON 1行のはず: ${r.stdout}`);
  return JSON.parse(out[0]);
}

test('AC1: 最後のメインの usage の input+cache_creation+cache_read を返す', () => {
  const dir = fixture([
    assistant(usage(5, 1000, 100_000), { requestId: 'a' }),
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
    assistant(usage(3, 2000, 420_000), { requestId: 'b' }),
  ]);
  const r = run(dir);
  assert.equal(r.tokens, 422_003);
  assert.equal(r.threshold, 400_000);
  assert.equal(r.over, true);
  assert.equal(r.warning, null);
});

test('AC2: サブエージェントの行（isSidechain）は採らない', () => {
  const dir = fixture([
    assistant(usage(1, 0, 900_000), { requestId: 'main' }),
    assistant(usage(1, 0, 60_000), { requestId: 'side', isSidechain: true }),
  ]);
  const r = run(dir);
  assert.equal(r.tokens, 900_001);
  assert.equal(r.over, true);
});

test('AC3: 閾値ちょうどは over、1つ下は over でない。--threshold で変えられる', () => {
  assert.equal(run(fixture([assistant(usage(0, 0, 400_000))])).over, true);
  assert.equal(run(fixture([assistant(usage(0, 0, 399_999))])).over, false);
  const r = run(fixture([assistant(usage(0, 0, 150_000))]), { args: ['--threshold', '100000'] });
  assert.equal(r.threshold, 100_000);
  assert.equal(r.over, true);
});

test('AC4: 同じリクエストが複数行に分かれていても、最後の行の値になる', () => {
  // ハーネスは1リクエストを content ブロックごとの複数行で書き、先頭行は途中経過になる。
  const dir = fixture([
    assistant(usage(2, 0, 10), { requestId: 'r' }),
    assistant(usage(2, 500, 300_000), { requestId: 'r' }),
  ]);
  assert.equal(run(dir).tokens, 300_502);
});

test('AC5: 判定できないときは tokens:null・over:null・warning 付きで exit 0', () => {
  const noSid = run(fixture([assistant(usage(0, 0, 500_000))]), { sid: null });
  assert.deepEqual([noSid.tokens, noSid.over], [null, null]);
  assert.match(noSid.warning, /CLAUDE_CODE_SESSION_ID/);

  const noFile = run(fixture(null));
  assert.deepEqual([noFile.tokens, noFile.over], [null, null]);
  assert.match(noFile.warning, /見つからない/);

  const noUsage = run(fixture([JSON.stringify({ type: 'user', message: { content: 'x' } }), '{壊れた行']));
  assert.deepEqual([noUsage.tokens, noUsage.over], [null, null]);
  assert.match(noUsage.warning, /usage/);
});

test('AC6: 別セッションのファイルは読まない', () => {
  const dir = fixture([assistant(usage(0, 0, 800_000))], { sid: 'other-session' });
  const r = run(dir);
  assert.equal(r.tokens, null);
});
