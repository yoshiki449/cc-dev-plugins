#!/usr/bin/env node
'use strict';

// workflow の agent() がどのモデルで動くかの振り分けを固定する。
// 実行: node --test plugins/dev-flow/workflows/model-routing.test.js
//
// なぜ必要か:
//   agent() は model を省くとメインセッションのモデルを引き継ぐ。メインは Opus で動かす前提なので、
//   SHA の取得や md への追記まで Opus で走る。雑務は CHORE_MODEL（Sonnet）に寄せ、
//   判断が要る呼び出しだけを引き継ぎのまま残している。
//   新しく agent() を足したときに振り分けを忘れると、黙って Opus に戻る（壊れはしないので気づけない）。
//   だから「どの呼び出しもどれか1つに分類されている」ことを全件で検査する。
//
// 落ちたときの直し方:
//   足した呼び出しが雑務なら opts に `model: CHORE_MODEL` を付ける。
//   Phase 分割・修正計画のように結果の質がループ全体を左右するなら、label を JUDGMENT_LABELS に足す。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = __dirname;
const AGENTS_DIR = path.join(WORKFLOWS_DIR, '..', 'agents');
const SKILLS_DIR = path.join(WORKFLOWS_DIR, '..', 'skills');
const WORKFLOWS = ['build.workflow.js', 'feedback-fix.workflow.js'];

// メインのモデルを引き継ぐ呼び出し。allowlist にしているのは、
// 「model を付けていないものは判断役」と逆向きに書くと、付け忘れがそのまま判断役扱いで通るため。
const JUDGMENT_LABELS = new Set([
  'plan/phase-split',
  'plan/report-only',
  'fix/plan-attempt*',
  'replan',
  'replan/report-only',
]);

const read = (p) => fs.readFileSync(p, 'utf8');

// 呼び出しの最後のトップレベル引数（opts は常に最後に渡している）を返す。プロンプトはテンプレートリテラルで、
// 中の ${...} にも括弧・カンマ・別のテンプレートが入るので、文字列の内外を追いながら数える。
function readLastCallArg(src, openIdx) {
  const stack = [')'];
  let lastArgStart = openIdx + 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); i++; continue; }
      if (ch === '$' && src[i + 1] === '{') { stack.push('}'); i += 2; continue; }
      i++; continue;
    }
    if (top === "'" || top === '"') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === top) stack.pop();
      i++; continue;
    }
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (ch === '`' || ch === "'" || ch === '"') { stack.push(ch); i++; continue; }
    if (ch === ',' && stack.length === 1) lastArgStart = i + 1;
    else if (ch === '(') stack.push(')');
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === ')' || ch === '}' || ch === ']') {
      assert.equal(ch, top, `括弧の対応が取れない（offset ${i}）`);
      stack.pop();
      if (stack.length === 0) return src.slice(lastArgStart, i).trim();
    }
    i++;
  }
  throw new Error(`閉じ括弧が見つからない（offset ${openIdx}）`);
}

function extractCalls(file) {
  const src = read(path.join(WORKFLOWS_DIR, file));
  const calls = [];
  const re = /\b(agent|schemaAgent)\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    // schemaAgent の定義と、その中で opts をそのまま中継する agent(prompt, opts) は呼び出し元ではない
    if (/function\s+$/.test(before)) continue;
    const lineHead = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    if (lineHead.includes('//')) continue;
    const opts = readLastCallArg(src, m.index + m[0].length - 1);
    if (opts === 'opts') continue;
    const labelMatch = opts.match(/label:\s*(['`])([^'`]*)\1/);
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({
      line,
      opts,
      label: labelMatch ? labelMatch[2].replace(/\$\{[^}]*\}/g, '*') : null,
    });
  }
  return calls;
}

for (const file of WORKFLOWS) {
  test(`${file}: CHORE_MODEL は sonnet に固定されている`, () => {
    assert.match(read(path.join(WORKFLOWS_DIR, file)), /^const CHORE_MODEL = 'sonnet'$/m);
  });

  test(`${file}: すべての agent() 呼び出しがモデルの振り分けに分類されている`, () => {
    const calls = extractCalls(file);
    assert.ok(calls.length >= 20, `呼び出しの抽出件数が少なすぎる（${calls.length}件）。抽出器が壊れている`);
    for (const c of calls) {
      const where = `${file}:${c.line} label=${c.label}`;
      assert.ok(c.opts.startsWith('{'), `${where}: opts オブジェクトが最後の引数に無い`);
      assert.ok(c.label, `${where}: label が無い。分類できないので label を付ける`);
      if (/\bagentType:/.test(c.opts)) continue;
      if (JUDGMENT_LABELS.has(c.label)) {
        assert.doesNotMatch(c.opts, /\bmodel:/, `${where}: 判断役にモデルが指定されている`);
        continue;
      }
      assert.match(c.opts, /\bmodel: CHORE_MODEL\b/, `${where}: 雑務なのに model: CHORE_MODEL が無い（メインの Opus で走る）`);
    }
  });

  test(`${file}: 判断役の allowlist がすべて実在する`, () => {
    // 呼び出しを消したのに allowlist が残ると、同名で足した雑務が素通りする
    const labels = new Set(extractCalls(file).map((c) => c.label));
    const expected = file === 'build.workflow.js'
      ? ['plan/phase-split', 'plan/report-only', 'fix/plan-attempt*']
      : ['replan', 'replan/report-only'];
    for (const l of expected) assert.ok(labels.has(l), `${file}: 判断役 ${l} が見つからない`);
  });
}

const frontmatterModel = (name) => {
  const fm = read(path.join(AGENTS_DIR, `${name}.md`)).split(/^---$/m)[1];
  const m = fm.match(/^model:\s*(\S+)$/m);
  return m ? m[1] : null;
};

test('定型の生成・採点をする agent は sonnet に固定されている', () => {
  assert.equal(frontmatterModel('explain-diff-generator'), 'sonnet');
  assert.equal(frontmatterModel('loop-eval-grader'), 'sonnet');
});

test('生成役を検証・監督する agent はメインのモデルを引き継ぐ', () => {
  // test-writer / implementer は sonnet。ここまで sonnet にすると検証役が生成役と同じモデルになり、
  // 同じ盲点を共有する（adversarial-verifier と loop-supervisor はそれを破るための役）
  assert.equal(frontmatterModel('adversarial-verifier'), 'inherit');
  assert.equal(frontmatterModel('loop-supervisor'), 'inherit');
});

test('auto-build / auto-feedback の supervisor_model の例が生成役と同じモデルを勧めていない', () => {
  for (const skill of ['auto-build', 'auto-feedback']) {
    const line = read(path.join(SKILLS_DIR, skill, 'SKILL.md')).split('\n').find((l) => /^\s*supervisor_model:/.test(l));
    assert.ok(line, `${skill}: supervisor_model の行が無い`);
    assert.doesNotMatch(line, /claude-sonnet/, `${skill}: implementer と同じ Sonnet を例に挙げている`);
  }
});
