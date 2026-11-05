// setup-script-template.sh の「コメントを外して使う」ブロックが、そのまま貼っても構文エラーにならないことを固定する。
// 実測の動機: docker pull 行に <イメージ名:タグ> のプレースホルダが残り、コメントを外した利用者の Setup script が
// `syntax error near unexpected token '<'` で落ちた。実行: node --test <this file>
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'setup-script-template.sh');
const src = fs.readFileSync(tpl, 'utf8');

test('テンプレート本体は構文エラーにならない', () => {
  assert.strictEqual(spawnSync('bash', ['-n', tpl]).status, 0);
});

test('docker pull ブロックはコメントを外しても構文エラーにならない（プレースホルダを置かない）', () => {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# IMAGES='));
  assert.ok(start >= 0, 'IMAGES ブロックが無い');
  const block = [];
  for (let i = start; i < lines.length && /^# \S/.test(lines[i]); i++) block.push(lines[i].replace(/^# /, ''));
  const joined = block.join('\n');
  assert.ok(!/<[^>\n]+>/.test(joined), 'プレースホルダ < > が残っている');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-')), 't.sh');
  fs.writeFileSync(f, joined);
  assert.strictEqual(spawnSync('bash', ['-n', f]).status, 0);
});
