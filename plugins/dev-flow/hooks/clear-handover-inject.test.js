#!/usr/bin/env node
'use strict';

// clear-handover-inject.sh（/clear 後の引継書要約の自動注入）のテスト。Issue #67。
// 実行: node --test plugins/dev-flow/hooks/clear-handover-inject.test.js
//
// SessionStart の source が clear のときだけ、stdin の cwd の .agent/handover-*.md から
// 1件を選んで要約を標準出力へ出す。選び方はブランチ名の issue<N> を優先し、
// 無ければ全体の最新＋注意書き。終了コードは常に 0（セッション開始を止めない）。
// 「最新」はファイル名の日付で決める。mtime には頼らない（E1 / E4 で mtime を逆順にして固定する）。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'clear-handover-inject.sh');
const HOOKS_JSON = path.join(__dirname, 'hooks.json');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const HEADING = '## 前回フェーズの引継書（/clear 後の自動注入）';
const CLOSING = '状況を答える前に、この引継書を読むこと。貼られた再開プロンプトに引継書のパスがあれば、そちらを優先する。';
const BODY_MARKER = 'BODY-ONLY-MARKER-7f3a9c';

function mkdtemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

/** git init -b <branch> したリポジトリ。コミットは不要。 */
function makeRepo(t, branch) {
  const dir = mkdtemp(t, 'clear-handover-inject-');
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, env: GIT_ENV });
  fs.mkdirSync(path.join(dir, '.agent'));
  return dir;
}

function handoverBody({ prev = 'plan', next = 'setup', worktree } = {}) {
  const lines = ['# 引継書', ''];
  if (prev) lines.push(`- 直前フェーズ: ${prev}`);
  if (next) lines.push(`- 次フェーズ: ${next}`);
  if (worktree) lines.push(`- **worktree 絶対パス**: \`${worktree}\``);
  lines.push('', BODY_MARKER, '');
  return lines.join('\n');
}

function put(repo, name, opts = {}) {
  const p = path.join(repo, '.agent', name);
  fs.writeFileSync(p, handoverBody(opts));
  return p;
}

function setMtime(p, epochSec) {
  fs.utimesSync(p, epochSec, epochSec);
}

/** プロセスの cwd は無関係なディレクトリにし、stdin の cwd だけが頼りになるようにする。 */
function run(t, payload, { raw } = {}) {
  const elsewhere = mkdtemp(t, 'clear-handover-inject-elsewhere-');
  const input = raw !== undefined ? raw : JSON.stringify(payload);
  const r = spawnSync('bash', [HOOK], { cwd: elsewhere, input, env: GIT_ENV, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', lines: (r.stdout || '').split('\n') };
}

const clear = (cwd) => ({ source: 'clear', cwd });

const NOTE_E2 = '注意: ブランチの Issue #67 の引継書は無く、別 Issue のものです。';
const NOTE_E3 = '注意: ブランチ名から Issue を特定できないため、別 Issue の引継書の可能性があります。';

test('E1: ブランチの Issue の引継書を、日付が新しい別 Issue より優先して注入する（mtime は逆順）', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const other = put(repo, 'handover-20261020-1000-issue66.md', { prev: 'ship', next: 'done' });
  const mine = put(repo, 'handover-20261020-0900-issue67.md');
  // 日付は issue66 が新しいが、mtime は issue67 の方を新しくする。
  setMtime(other, 1000000);
  setMtime(mine, 3000000);
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  const expected = [
    HEADING,
    `引継書: ${mine}（作成: 2026-10-20 09:00）`,
    '直前フェーズ: plan',
    '次フェーズ: setup',
    `作業場所: ${repo}（ブランチ: issue-67-clear-inject、Issue: #67）`,
    CLOSING,
  ];
  const idx = expected.map((l) => r.lines.indexOf(l));
  idx.forEach((i, n) => assert.ok(i >= 0, `行が無い: ${expected[n]}\n出力:\n${r.stdout}`));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), '行の順序が仕様どおり');
  assert.ok(!r.stdout.includes('注意:'), '該当ありのときは注意書きを出さない');
  assert.ok(!r.stdout.includes('issue66'), '別 Issue の引継書を出さない');
  assert.ok(!r.stdout.includes('直前フェーズ: ship'), '別 Issue の引継書の中身を出さない');
});

test('E1: 引継書の全文は注入しない（本文にだけ書いた目印が出力に無い）', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  put(repo, 'handover-20261020-0900-issue67.md');
  const r = run(t, clear(repo));
  assert.ok(r.stdout.includes(HEADING), '注入自体は行われている');
  assert.ok(!r.stdout.includes(BODY_MARKER), `全文を出している:\n${r.stdout}`);
});

test('E1: feature/issue-67-x のようなスラッシュ入りブランチでも Issue #67 を取れる', (t) => {
  const repo = makeRepo(t, 'feature/issue-67-x');
  put(repo, 'handover-20261020-1000-issue66.md');
  const mine = put(repo, 'handover-20261020-0900-issue67.md');
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-20 09:00）`), r.stdout);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: feature/issue-67-x、Issue: #67）`), r.stdout);
  assert.ok(!r.stdout.includes('注意:'));
});

test('E1: issue6 のブランチは issue67 の引継書を選ばない（前方一致の取り違え防止）', (t) => {
  const repo = makeRepo(t, 'issue-6-foo');
  put(repo, 'handover-20261020-1000-issue67.md');
  const mine = put(repo, 'handover-20261019-0900-issue6.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-19 09:00）`), r.stdout);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: issue-6-foo、Issue: #6）`), r.stdout);
});

test('E2: ブランチの Issue の引継書が無ければ別 Issue の最新を注入し、注意書きを出す', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const other = put(repo, 'handover-20261020-1000-issue66.md');
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  assert.ok(r.lines.includes(`引継書: ${other}（作成: 2026-10-20 10:00）`), r.stdout);
  assert.ok(r.lines.includes(NOTE_E2), `注意書きが無い:\n${r.stdout}`);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: issue-67-clear-inject、Issue: #66）`), '番号は選ばれた引継書のもの');
  assert.ok(r.lines.indexOf(NOTE_E2) < r.lines.indexOf(CLOSING), '注意書きは定型文より前');
  assert.ok(r.lines.includes(CLOSING));
});

test('E3: ブランチ名に番号が無ければ全体の最新（mtime ではなく日付）を注入し、注意書きを出す', (t) => {
  const repo = makeRepo(t, 'feature-12');
  const older = put(repo, 'handover-20261016-1030-issue12.md');
  const newer = put(repo, 'handover-20261017-1653-issue8.md');
  setMtime(newer, 1000000);
  setMtime(older, 3000000);
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  assert.ok(r.lines.includes(`引継書: ${newer}（作成: 2026-10-17 16:53）`), r.stdout);
  assert.ok(r.lines.includes(NOTE_E3), `注意書きが無い:\n${r.stdout}`);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: feature-12、Issue: #8）`), r.stdout);
  assert.ok(!r.stdout.includes('Issue #12 の引継書は無く'), '番号ありの注意書きを混ぜない');
});

test('E4: 同じ Issue の引継書が複数なら日付が新しい方を注入する（mtime は逆順）', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const older = put(repo, 'handover-20261020-0900-issue67.md');
  const newer = put(repo, 'handover-20261020-1500-issue67.md');
  setMtime(newer, 1000000);
  setMtime(older, 3000000);
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${newer}（作成: 2026-10-20 15:00）`), r.stdout);
  assert.ok(!r.stdout.includes('0900'), '古い方を出さない');
  assert.ok(!r.stdout.includes('注意:'), '該当ありのときは注意書きを出さない');
});

test('E5: 引継書が1件も無ければ何も出力せず終了コード 0', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  fs.writeFileSync(path.join(repo, '.agent', 'knowledge.md'), 'x\n');
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('E5: .agent/ 自体が無くても何も出力せず終了コード 0', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  fs.rmSync(path.join(repo, '.agent'), { recursive: true });
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('E6: source が startup / resume / 欠落なら、引継書があっても何も出力しない', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  put(repo, 'handover-20261020-0900-issue67.md');
  for (const payload of [
    { source: 'startup', cwd: repo },
    { source: 'resume', cwd: repo },
    { cwd: repo },
  ]) {
    const r = run(t, payload);
    assert.equal(r.status, 0, JSON.stringify(payload));
    assert.equal(r.stdout, '', `出力してはいけない: ${JSON.stringify(payload)}`);
  }
  // 対照: clear なら同じ構成で出力される（無出力が「引継書が読めない」ことの偽陽性でない）
  assert.ok(run(t, clear(repo)).stdout.includes(HEADING));
});

test('E7: 引継書に直前・次フェーズの行が無ければ、その行を出さずパスと作業場所だけを出す', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const mine = put(repo, 'handover-20261020-0900-issue67.md', { prev: null, next: null });
  const r = run(t, clear(repo));
  assert.equal(r.status, 0);
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-20 09:00）`), r.stdout);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: issue-67-clear-inject、Issue: #67）`), r.stdout);
  assert.ok(!r.stdout.includes('直前フェーズ'), `推測で埋めない:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('次フェーズ'), `推測で埋めない:\n${r.stdout}`);
});

test('E7: 片方の行だけある引継書は、ある方だけを出す', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  put(repo, 'handover-20261020-0900-issue67.md', { prev: 'implement', next: null });
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes('直前フェーズ: implement'), r.stdout);
  assert.ok(!r.stdout.includes('次フェーズ'), r.stdout);
});

test('ストーリー2: 注入文の末尾に「状況を答える前に引継書を読む」定型文が必ず付く', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  put(repo, 'handover-20261020-0900-issue67.md');
  const r = run(t, clear(repo));
  assert.equal(r.lines.filter((l) => l !== '').pop(), CLOSING, '定型文が最後の行');
});

test('作業場所: 引継書に worktree 絶対パスの欄があればそのパスを使う', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const wt = '/example/worktrees/issue-67';
  put(repo, 'handover-20261020-0900-issue67.md', { worktree: wt });
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`作業場所: ${wt}（ブランチ: issue-67-clear-inject、Issue: #67）`), r.stdout);
});

test('cwd は stdin の値を使う（プロセスの cwd や引継書の無い別リポジトリを見ない）', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  put(repo, 'handover-20261020-0900-issue67.md');
  const empty = makeRepo(t, 'main'); // 引継書の無いリポジトリがプロセス cwd
  const r = spawnSync('bash', [HOOK], {
    cwd: empty,
    input: JSON.stringify(clear(repo)),
    env: GIT_ENV,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(path.join(repo, '.agent', 'handover-20261020-0900-issue67.md')), r.stdout);
});

test('壊れた JSON / 空の stdin でも何も出さず終了コード 0', (t) => {
  for (const raw of ['{not json', '', 'null']) {
    const r = run(t, null, { raw });
    assert.equal(r.status, 0, `raw=${JSON.stringify(raw)}`);
    assert.equal(r.stdout, '', `raw=${JSON.stringify(raw)}`);
  }
});

test('cwd が存在しないパスでも何も出さず終了コード 0', (t) => {
  const r = run(t, clear('/nonexistent/clear-handover-inject-test'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ---- hooks.json の契約 ----

const hooksRaw = fs.existsSync(HOOKS_JSON) ? fs.readFileSync(HOOKS_JSON, 'utf8') : '';
const sessionStart = () => {
  const j = JSON.parse(hooksRaw);
  const entries = j.hooks && j.hooks.SessionStart;
  assert.ok(Array.isArray(entries), 'SessionStart のエントリが配列で存在する');
  return entries;
};
const commandsOf = (entry) => (entry.hooks || []).map((h) => h.command || '');

test('hooks.json: matcher がちょうど clear の SessionStart エントリが1つあり、clear-handover-inject.sh を指す', () => {
  const clearEntries = sessionStart().filter((e) => e.matcher === 'clear');
  assert.equal(clearEntries.length, 1);
  const cmds = commandsOf(clearEntries[0]);
  assert.ok(cmds.some((c) => c.includes('clear-handover-inject.sh')), JSON.stringify(cmds));
});

test('hooks.json: 既存の startup|resume エントリが残り、cloud-session-start.sh を指す', () => {
  const entries = sessionStart().filter((e) => e.matcher === 'startup|resume');
  assert.equal(entries.length, 1);
  assert.ok(commandsOf(entries[0]).some((c) => c.includes('cloud-session-start.sh')));
});

test('hooks.json: startup|resume のエントリは clear-handover-inject.sh を呼ばない（E6）', () => {
  const entry = sessionStart().find((e) => e.matcher === 'startup|resume');
  assert.ok(entry);
  assert.ok(!commandsOf(entry).some((c) => c.includes('clear-handover-inject.sh')));
});

test('hooks.json: session-context-inject.sh は登録しない（依頼者が検証中で外してある）', () => {
  assert.ok(hooksRaw.length > 0, 'hooks.json が読める');
  assert.ok(!hooksRaw.includes('session-context-inject.sh'));
});

// ---- 敵対的検証の指摘（ブランチ名・フェーズ行・サブディレクトリ・日付形式・スクリプト実在）----

function putRaw(repo, name, content) {
  const p = path.join(repo, '.agent', name);
  fs.writeFileSync(p, content);
  return p;
}

test('ブランチ名: issue67-foo（ハイフン無し）でも Issue #67 を取れる', (t) => {
  const repo = makeRepo(t, 'issue67-foo');
  put(repo, 'handover-20261020-1000-issue66.md');
  const mine = put(repo, 'handover-20261020-0900-issue67.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-20 09:00）`), r.stdout);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: issue67-foo、Issue: #67）`), r.stdout);
  assert.ok(!r.stdout.includes('注意:'), r.stdout);
});

test('ブランチ名: tissue-5 は issue の直前が英小文字なので番号なし扱い（E3）', (t) => {
  const repo = makeRepo(t, 'tissue-5');
  put(repo, 'handover-20261016-1030-issue5.md');
  const newer = put(repo, 'handover-20261017-1653-issue8.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${newer}（作成: 2026-10-17 16:53）`), r.stdout);
  assert.ok(r.lines.includes(NOTE_E3), r.stdout);
  assert.ok(!r.stdout.includes('Issue #5 の引継書は無く'), r.stdout);
});

test('ブランチ名: issue が複数あれば最初の番号を採用する（issue6 の引継書があればそれを選ぶ）', (t) => {
  const repo = makeRepo(t, 'feature/issue-6-and-issue-67');
  put(repo, 'handover-20261020-1000-issue67.md');
  const mine = put(repo, 'handover-20261019-0900-issue6.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-19 09:00）`), r.stdout);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: feature/issue-6-and-issue-67、Issue: #6）`), r.stdout);
  assert.ok(!r.stdout.includes('注意:'), r.stdout);
});

test('ブランチ名: issue が複数で最初の番号の引継書が無ければ #6 の注意書き（E2）', (t) => {
  const repo = makeRepo(t, 'feature/issue-6-and-issue-67');
  const other = put(repo, 'handover-20261020-1000-issue67.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${other}（作成: 2026-10-20 10:00）`), r.stdout);
  assert.ok(r.lines.includes('注意: ブランチの Issue #6 の引継書は無く、別 Issue のものです。'), r.stdout);
});

test('フェーズ行: 行頭が「- 直前フェーズ:」の行だけを拾い、本文中の語は拾わない', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', [
    '# 引継書',
    '',
    'メモ: ここで 直前フェーズ: bogus-prev と 次フェーズ: bogus-next が文中に出る。',
    '',
    '- 直前フェーズ: real-prev',
    '- 次フェーズ: real-next',
    '',
  ].join('\n'));
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes('直前フェーズ: real-prev'), r.stdout);
  assert.ok(r.lines.includes('次フェーズ: real-next'), r.stdout);
  assert.ok(!r.stdout.includes('bogus'), `文中の語を拾っている:\n${r.stdout}`);
});

test('フェーズ行: 行頭固定なので、行頭が「- 」でない記述しか無ければ行を出さない', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', [
    '# 引継書',
    '',
    '説明の途中で 直前フェーズ: bogus-prev と 次フェーズ: bogus-next に触れるだけ。',
    '',
  ].join('\n'));
  const r = run(t, clear(repo));
  assert.ok(r.stdout.includes(HEADING), r.stdout);
  assert.ok(!r.stdout.includes('直前フェーズ'), r.stdout);
  assert.ok(!r.stdout.includes('次フェーズ'), r.stdout);
});

test('フェーズ行: 値が空の行は無視し、後ろの値のある同種の行を使う', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', [
    '# 引継書',
    '- 直前フェーズ:',
    '- 次フェーズ:    ',
    '',
    '- 直前フェーズ: later-prev',
    '- 次フェーズ: later-next',
    '',
  ].join('\n'));
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes('直前フェーズ: later-prev'), r.stdout);
  assert.ok(r.lines.includes('次フェーズ: later-next'), r.stdout);
});

test('フェーズ行: どれも空なら行を出さない', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', '# 引継書\n- 直前フェーズ:\n- 次フェーズ:   \n');
  const r = run(t, clear(repo));
  assert.ok(r.stdout.includes(HEADING), r.stdout);
  assert.ok(!r.stdout.includes('直前フェーズ'), r.stdout);
  assert.ok(!r.stdout.includes('次フェーズ'), r.stdout);
});

test('フェーズ行: CRLF の引継書でも出力に CR を含めない', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', '# 引継書\r\n- 直前フェーズ: plan\r\n- 次フェーズ: setup\r\n');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes('直前フェーズ: plan'), JSON.stringify(r.stdout));
  assert.ok(r.lines.includes('次フェーズ: setup'), JSON.stringify(r.stdout));
  assert.ok(!r.stdout.includes('\r'), JSON.stringify(r.stdout));
});

test('フェーズ行: 値は先頭200文字までに切る（3000文字の値が全量出ない）', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', `# 引継書\n- 直前フェーズ: ${'x'.repeat(3000)}\n- 次フェーズ: setup\n`);
  const r = run(t, clear(repo));
  const line = r.lines.find((l) => l.startsWith('直前フェーズ:'));
  assert.ok(line, `行が無い:\n${r.stdout.slice(0, 500)}`);
  assert.ok([...line].length <= 200 + '直前フェーズ: '.length, `長すぎる: ${[...line].length} 文字`);
  assert.ok(line.includes('x'.repeat(100)), '先頭部分は残っている');
  assert.ok(r.stdout.length < 1500, `出力全体が長い: ${r.stdout.length}`);
});

test('サブディレクトリ: cwd が <repo>/src/deep でもリポジトリ直下の .agent/ から選ぶ', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  put(repo, 'handover-20261020-1000-issue66.md');
  const mine = put(repo, 'handover-20261020-0900-issue67.md');
  const deep = path.join(repo, 'src', 'deep');
  fs.mkdirSync(deep, { recursive: true });
  const r = run(t, clear(deep));
  assert.equal(r.status, 0);
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-20 09:00）`), r.stdout);
  assert.ok(r.lines.includes(`作業場所: ${repo}（ブランチ: issue-67-clear-inject、Issue: #67）`), r.stdout);
  assert.ok(!r.stdout.includes('注意:'), r.stdout);
});

test('git リポジトリでない cwd では従来どおり cwd の .agent/ を見る', (t) => {
  const dir = mkdtemp(t, 'clear-handover-inject-nogit-');
  fs.mkdirSync(path.join(dir, '.agent'));
  const mine = put(dir, 'handover-20261020-0900-issue67.md');
  const r = run(t, clear(dir));
  assert.equal(r.status, 0);
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-20 09:00）`), r.stdout);
});

test('日付のみのファイル名（時刻なし）は「（作成: 2026-10-20）」と出す', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const mine = put(repo, 'handover-20261020-issue67.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${mine}（作成: 2026-10-20）`), r.stdout);
});

test('日付なしのファイル名は「（作成: …）」を付けず「引継書: <パス>」だけ', (t) => {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const mine = put(repo, 'handover-issue67.md');
  const r = run(t, clear(repo));
  assert.ok(r.lines.includes(`引継書: ${mine}`), r.stdout);
  assert.ok(!r.stdout.includes('作成:'), r.stdout);
});

test('hooks.json: clear エントリが参照する hook スクリプトが実在し、bash -n で構文エラーが無い', () => {
  const entry = sessionStart().find((e) => e.matcher === 'clear');
  assert.ok(entry, 'clear エントリがある');
  const cmd = commandsOf(entry).find((c) => c.includes('clear-handover-inject.sh'));
  assert.ok(cmd, 'clear-handover-inject.sh を呼ぶ command がある');
  assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}/hooks/clear-handover-inject.sh'), cmd);
  const script = path.join(path.join(__dirname, '..'), 'hooks', 'clear-handover-inject.sh');
  assert.ok(fs.existsSync(script), `スクリプトが無い: ${script}`);
  const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n 失敗:\n${r.stderr}`);
});

// ---- セルフレビュー指摘: 切り詰めはロケールに依存せず、妥当な UTF-8 を保つ（Issue #67）----

/** 出力を Buffer のまま受け取る run。envOverride で LANG / LC_ALL などを上書きできる。 */
function runBytes(t, payload, envOverride = {}) {
  const elsewhere = mkdtemp(t, 'clear-handover-inject-elsewhere-');
  const r = spawnSync('bash', [HOOK], {
    cwd: elsewhere,
    input: JSON.stringify(payload),
    env: { ...GIT_ENV, ...envOverride },
  });
  return { status: r.status, buf: r.stdout || Buffer.alloc(0) };
}

function assertValidUtf8CutAt200(t, envOverride) {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  const jp = '日本語'.repeat(100); // 300 文字（900 バイト）
  putRaw(repo, 'handover-20261020-0900-issue67.md', `# 引継書\n- 直前フェーズ: ${jp}\n- 次フェーズ: ${jp}\n`);
  const r = runBytes(t, clear(repo), envOverride);
  assert.equal(r.status, 0);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(r.buf);
  } catch (e) {
    assert.fail(`出力が妥当な UTF-8 ではない（文字の途中で切れている）: ${e.message}`);
  }
  assert.ok(!text.includes('�'), 'U+FFFD を含まない');
  for (const label of ['直前フェーズ: ', '次フェーズ: ']) {
    const line = text.split('\n').find((l) => l.startsWith(label));
    assert.ok(line, `${label}の行が無い:\n${text.slice(0, 500)}`);
    const value = line.slice(label.length);
    const n = [...value].length;
    assert.ok(n >= 1 && n <= 200, `${label}の値の文字数が 1〜200 でない: ${n}`);
    assert.match(value, /^[日本語]+$/u, `${label}の値が先頭の連続した日本語だけでない: ${JSON.stringify(value)}`);
  }
}

test('切り詰め: POSIX ロケール（LANG=C LC_ALL=C）でも日本語300文字の値が妥当な UTF-8 で200文字以内に切れる', (t) => {
  assertValidUtf8CutAt200(t, { LANG: 'C', LC_ALL: 'C' });
});

test('切り詰め: 既定のロケールでも日本語300文字の値が妥当な UTF-8 で200文字以内に切れる', (t) => {
  assertValidUtf8CutAt200(t, {});
});

test('切り詰め: UTF-8 ロケールが無い OS（locale -a が C / POSIX のみ）でも妥当な UTF-8 で200文字以内に切れる', (t) => {
  // macOS 等を再現する。PATH の先頭に偽の locale を置き、元の PATH は後ろに残す。
  const fakeBin = mkdtemp(t, 'clear-handover-inject-fakelocale-');
  const fake = path.join(fakeBin, 'locale');
  fs.writeFileSync(fake, "#!/bin/sh\nprintf 'C\\nPOSIX\\n'\n");
  fs.chmodSync(fake, 0o755);
  assertValidUtf8CutAt200(t, { PATH: `${fakeBin}${path.delimiter}${GIT_ENV.PATH}` });
  // 比較: 偽の locale を使わない通常実行でも 1〜200 文字になる
  assertValidUtf8CutAt200(t, {});
});

// 日本語300文字だけだと 600 バイトがちょうど文字境界（3バイト x 200）に揃い、不完全な末尾の除去を
// 外しても落ちない。先頭に 1 / 2 バイトの文字を付け、4 バイト文字を混ぜて、文字の途中で切れる入力にする。
function assertCutOnCharBoundary(t, input, envOverride) {
  const repo = makeRepo(t, 'issue-67-clear-inject');
  putRaw(repo, 'handover-20261020-0900-issue67.md', `# 引継書\n- 直前フェーズ: ${input}\n- 次フェーズ: ${input}\n`);
  const r = runBytes(t, clear(repo), envOverride);
  assert.equal(r.status, 0);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(r.buf);
  } catch (e) {
    assert.fail(`出力が妥当な UTF-8 ではない（入力 ${JSON.stringify(input.slice(0, 4))}…）: ${e.message}`);
  }
  assert.ok(!text.includes('�'), 'U+FFFD を含まない');
  const chars = [...input];
  for (const label of ['直前フェーズ: ', '次フェーズ: ']) {
    const line = text.split('\n').find((l) => l.startsWith(label));
    assert.ok(line, `${label}の行が無い:\n${text.slice(0, 500)}`);
    const value = line.slice(label.length);
    const n = [...value].length;
    assert.ok(n >= 1 && n <= 200, `${label}の値の文字数が 1〜200 でない: ${n}`);
    assert.equal(value, chars.slice(0, n).join(''), `${label}の値が入力の先頭部分になっていない`);
  }
}

test('切り詰め: 文字の途中でバイト切りが起きる入力（1・2・4バイト文字が混在）でも、UTF-8 ロケール無しで妥当な UTF-8 に切れる', (t) => {
  const jp = '日本語'.repeat(100);
  const inputs = [
    `a${jp}`, // 600 バイトで日本語の途中（2バイト）になる
    `é${jp}`, // 2バイト文字が先頭
    `${'日本語'.repeat(50)}${'😀'.repeat(100)}`, // 600 バイトで絵文字の途中（2バイト）になる
  ];
  const fakeBin = mkdtemp(t, 'clear-handover-inject-fakelocale-');
  const fake = path.join(fakeBin, 'locale');
  fs.writeFileSync(fake, "#!/bin/sh\nprintf 'C\\nPOSIX\\n'\n");
  fs.chmodSync(fake, 0o755);
  for (const input of inputs) {
    assertCutOnCharBoundary(t, input, { PATH: `${fakeBin}${path.delimiter}${GIT_ENV.PATH}` });
    assertCutOnCharBoundary(t, input, {});
  }
});
