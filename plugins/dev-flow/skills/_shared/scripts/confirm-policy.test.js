#!/usr/bin/env node
'use strict';

// 確認レベルの共通文のドリフト検出。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/confirm-policy.test.js
//
// 正準は _shared/reference/confirm-policy.md で、フェーズを進める dev-* スキルの SKILL.md に複製で置いている。
// 実際にメインセッションが読むのは消費側なので、正準だけ直すと効かない。
// 語の存在チェックは指示を反転しても通るので、マーカー内の行を byte-identical で比較し、
// 正準側の極性（どの確認を light でも聞くか）は AC3 で別に固定する。
// 消費者リストは _shared/README.md の表から読む。テスト側に文字列を転記しない。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { section } = require('./md-section.js');

const SKILLS = path.join(__dirname, '..', '..');
const AGENTS = path.join(SKILLS, '..', 'agents');
const REFERENCE = path.join(SKILLS, '_shared', 'reference', 'confirm-policy.md');
const README = path.join(SKILLS, '_shared', 'README.md');
const CONSUMER_SECTION = '## 確認レベルの消費者';
const KINDS = ['confirm-policy', 'confirm-policy-loop'];
const LOOP_SKILL = 'dev-loop';
const LINK = '](../_shared/reference/confirm-policy.md)';
const MUST_ASK = ['要件・範囲の確定', '取り返しのつかない操作', '仕様に無いユーザーに見える挙動', '推奨を付けられない拮抗'];

const read = (p) => fs.readFileSync(p, 'utf8');
const skillMd = (name) => path.join(SKILLS, name, 'SKILL.md');

function markedBy(md, name, where) {
  const m = md.match(new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /${name} -->`));
  assert.ok(m, `${where}: ${name} のマーカーが見つからない`);
  return m[1].split('\n').map((l) => l.replace(/^\s+/, '')).filter(Boolean);
}

function consumers() {
  return section(read(README), CONSUMER_SECTION)
    .split('\n')
    .map((l) => l.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter(Boolean)
    .map((m) => ({ skill: m[1], section: m[2], kind: m[3] }));
}

test('AC1: 消費者表がフェーズを進める7スキルを過不足なく持ち、種別は dev-loop だけが loop 版である', () => {
  // この配列は「フェーズを進行する dev-* スキル」の期待集合。新しいフェーズスキルを足したら更新させる。
  const phaseSkills = ['dev-fix', 'dev-implement', 'dev-loop', 'dev-qa', 'dev-self-review', 'dev-ship', 'dev-verify'];
  const rows = consumers();
  assert.deepEqual(rows.map((c) => c.skill).sort(), phaseSkills);
  for (const c of rows) {
    assert.equal(c.kind, c.skill === LOOP_SKILL ? 'confirm-policy-loop' : 'confirm-policy', `${c.skill} の種別が違う`);
  }
});

test('AC2: 全消費者の該当節のブロックが、種別に対応する正準と byte-identical である', () => {
  const ref = read(REFERENCE);
  for (const c of consumers()) {
    assert.deepEqual(
      markedBy(section(read(skillMd(c.skill)), c.section), c.kind, `${c.skill} / ${c.section}`),
      markedBy(ref, c.kind, 'reference'),
      `${c.skill} の ${c.kind} が reference と食い違っている。両方を同時に直すこと`,
    );
  }
});

test('AC3: 正準が「light でも4種は聞く・それ以外は推奨案で進める・聞けないなら停止」の極性を保っている', () => {
  const ref = read(REFERENCE);
  const n = markedBy(ref, 'confirm-policy', 'reference');
  assert.equal(n.length, 4, '通常版は4行のはず（打ち消しの行を足す変更を検知する）');
  for (const l of n) assert.match(l, /^- /);
  assert.match(n[0], /confirm-level\.sh/);
  assert.match(n[0], /--dir/);
  assert.match(n[0], /確認レベル/);
  assert.match(n[1], /strict/);
  assert.match(n[1], /light/);
  for (const k of MUST_ASK) assert.ok(n[1].includes(k), `2行目に「${k}」が無い`);
  assert.match(n[2], /light/);
  assert.ok(n[2].includes('推奨案で進める'));
  assert.ok(n[2].includes('自動採用'));
  assert.ok(n[2].includes('Deviations'));
  assert.ok(n[3].includes('待たずに停止し'));
  assert.ok(n[3].includes('引継書'));

  const l = markedBy(ref, 'confirm-policy-loop', 'reference');
  assert.equal(l.length, 4, 'dev-loop 版は4行のはず');
  const joined = l.join('\n');
  for (const k of MUST_ASK) assert.ok(joined.includes(k), `dev-loop 版に「${k}」が無い`);
  assert.ok(joined.includes('自動採用'));
  assert.ok(joined.includes('待たずに停止'));
  assert.ok(l.some((x) => x.includes('待たずに停止') && x.includes('halted-checkpoint')), '停止の行に halted-checkpoint が無い');
});

test('AC4: 全消費者の該当節から正準の文書へのリンクが生きている', () => {
  for (const c of consumers()) {
    const body = section(read(skillMd(c.skill)), c.section);
    assert.ok(body.includes(LINK), `${c.skill}: ${c.section} の中に reference へのリンクが無い`);
    assert.ok(fs.existsSync(path.join(SKILLS, c.skill, '..', '_shared', 'reference', 'confirm-policy.md')), `${c.skill}: リンク先が存在しない`);
  }
});

test('AC5: マーカーを持つファイルの集合が、表の消費者の集合と一致する（allowlist）', () => {
  const files = [];
  for (const d of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(skillMd(d.name))) files.push({ id: d.name, p: skillMd(d.name) });
  }
  if (fs.existsSync(AGENTS)) {
    for (const f of fs.readdirSync(AGENTS)) {
      if (f.endsWith('.md')) files.push({ id: `agents/${f}`, p: path.join(AGENTS, f) });
    }
  }
  const owners = files.filter((f) => /<!-- \/?confirm-policy/.test(read(f.p))).map((f) => f.id).sort();
  const table = consumers().map((c) => c.skill).sort();
  assert.ok(table.length > 0, '消費者の表が空');
  assert.deepEqual(owners, table, '表に無いファイルにマーカーがあるか、表にあるのにマーカーが無い');
});

test('AC6: 各消費者の該当節に同じ種別のマーカーが開き1・閉じ1で、他種別が混ざっていない', () => {
  for (const c of consumers()) {
    const body = section(read(skillMd(c.skill)), c.section);
    const count = (s) => body.split(s).length - 1;
    assert.equal(count(`<!-- ${c.kind} -->`), 1, `${c.skill}: ${c.kind} の開きが1つではない`);
    assert.equal(count(`<!-- /${c.kind} -->`), 1, `${c.skill}: ${c.kind} の閉じが1つではない`);
    for (const other of KINDS.filter((k) => k !== c.kind)) {
      assert.ok(!body.includes(`<!-- ${other} -->`) && !body.includes(`<!-- /${other} -->`), `${c.skill} に ${other} が混ざっている`);
    }
  }
});

test('AC7: 正準の文書に「設定ファイルの記法」「導入手順」「既知の限界」があり、要点を含む', () => {
  const ref = read(REFERENCE);
  section(ref, '## 設定ファイルの記法');
  assert.ok(section(ref, '## 導入手順').includes('git fetch'), '導入手順に git fetch が無い');
  assert.ok(section(ref, '## 既知の限界').includes('update-ref'), '既知の限界に update-ref が無い');
});

test('AC8: README のスクリプト表に scripts/confirm-level.sh が載っている', () => {
  const rows = read(README).split('\n').filter((l) => /^\|\s*`scripts\//.test(l));
  assert.ok(rows.some((l) => l.includes('scripts/confirm-level.sh')), 'スクリプト表に confirm-level.sh が無い');
});

test('AC9: 全消費者の SKILL.md の frontmatter が壊れていない', () => {
  for (const c of consumers()) {
    const md = read(skillMd(c.skill));
    assert.ok(md.startsWith('---\n'), `${c.skill}: 先頭が --- ではない`);
    assert.ok(md.indexOf('\n---\n', 4) > 0, `${c.skill}: frontmatter が閉じていない`);
  }
});

const AUTO_ADOPT_HEADING = '## 自動採用の記録';
const E2_HEADING = '### E2. PR作成';
const AUTO_ADOPT_ITEM = '自動採用した判断';

test('AC10: 正準の文書に「自動採用の記録」節があり、書式の例が 自動採用: → 根拠: → 変更時の影響: の順に1行で並ぶ', () => {
  const body = section(read(REFERENCE), AUTO_ADOPT_HEADING);
  assert.ok(body.includes(AUTO_ADOPT_ITEM), `節に「${AUTO_ADOPT_ITEM}」が無い`);
  assert.ok(body.includes('PR 本文'), '節に「PR 本文」が無い');
  assert.ok(
    body.split('\n').some((l) => /自動採用:.*根拠:.*変更時の影響:/.test(l)),
    '1行の中に「自動採用:」「根拠:」「変更時の影響:」がこの順で現れる書式の例が無い',
  );
});

test('AC11: dev-ship の E2 節に「自動採用した判断」の項目があり、light で入れ strict で入れない向きで書かれている', () => {
  const e2 = section(read(skillMd('dev-ship')), E2_HEADING);
  for (const w of [AUTO_ADOPT_ITEM, 'light', 'strict', '自動採用:', '引継書', '進捗ファイル', 'なし', 'マージ前', 'PR を修正']) {
    assert.ok(e2.includes(w), `E2 節に「${w}」が無い`);
  }
  // 項目の行と、それより深くインデントされた続きの行を1ブロックとして見る。
  const lines = e2.split('\n');
  const at = lines.findIndex((l) => l.includes(AUTO_ADOPT_ITEM));
  assert.notStrictEqual(at, -1, `E2 節に「${AUTO_ADOPT_ITEM}」を含む行が無い`);
  const indent = (l) => l.match(/^\s*/)[0].length;
  const block = [lines[at]];
  for (let i = at + 1; i < lines.length && lines[i].trim() && indent(lines[i]) > indent(lines[at]); i++) block.push(lines[i]);
  const text = block.join('\n');
  const li = text.indexOf('light');
  const si = text.indexOf('strict');
  assert.ok(li !== -1 && si !== -1, '項目のブロックに light と strict の両方が無い');
  assert.ok(li < si, '項目のブロックで light が strict より先に現れない（向きが反転している疑い）');
});

test('AC12: 「自動採用した判断」が E2 節の「2. 含める内容:」と「3. 複数リポジトリの場合は」の間に置かれている', () => {
  const e2 = section(read(skillMd('dev-ship')), E2_HEADING);
  const from = e2.indexOf('2. 含める内容:');
  const to = e2.indexOf('3. 複数リポジトリの場合は');
  assert.notStrictEqual(from, -1, 'E2 節に「2. 含める内容:」が無い');
  assert.notStrictEqual(to, -1, 'E2 節に「3. 複数リポジトリの場合は」が無い');
  assert.ok(from < to, '「2. 含める内容:」が「3. 複数リポジトリの場合は」より後ろにある');
  assert.ok(e2.slice(from, to).includes(AUTO_ADOPT_ITEM), `含める内容の箇条書きに「${AUTO_ADOPT_ITEM}」が無い`);
});
