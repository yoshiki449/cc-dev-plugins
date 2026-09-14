#!/usr/bin/env node
'use strict';

// workflow の agent() と agent 定義がどのモデルで動くかの振り分けを固定する。
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
//   Phase 分割・修正計画のように結果の質がループ全体を左右するなら、label を JUDGMENT_LABELS の該当ファイルに足す。
//   agent を足した・モデルを変えたなら EXPECTED_AGENT_MODELS を更新する（どの群に入るかを決めること）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = __dirname;
const AGENTS_DIR = path.join(WORKFLOWS_DIR, '..', 'agents');
const SKILLS_DIR = path.join(WORKFLOWS_DIR, '..', 'skills');

// メインのモデルを引き継ぐ呼び出し。allowlist にしているのは、
// 「model を付けていないものは判断役」と逆向きに書くと、付け忘れがそのまま判断役扱いで通るため。
// ファイル別にしているのは、別の workflow の判断役と同じ label を雑務に付けるだけで検査を抜けられないようにするため。
// 新しい workflow を足したら、判断役が無くても空配列でキーを足す（分類を決め忘れた workflow を落とすため）。
const JUDGMENT_LABELS = {
  'build.workflow.js': ['plan/phase-split', 'plan/report-only', 'fix/plan-attempt*'],
  'feedback-fix.workflow.js': ['replan', 'replan/report-only'],
};

const EXPECTED_AGENT_MODELS = {
  // 生成役を検証・監督する役。test-writer / implementer は sonnet なので、ここまで sonnet にすると
  // 検証役が生成役と同じモデルになり、同じ盲点を共有する
  'adversarial-verifier': 'inherit',
  'loop-supervisor': 'inherit',
  // REQUIREMENTS.md / DESIGN.md の質が後段の自律ループ全体を決める
  designer: 'inherit',
  'spec-writer': 'inherit',
  'project-orchestrator': 'opus',
  'ui-designer': 'opus',
  // 実装・テスト・レビュー・QA・定型文書
  'Code-Reviewer': 'sonnet',
  Debugger: 'sonnet',
  Spec: 'sonnet',
  'autonomous-tester': 'sonnet',
  'codex-cross-reviewer': 'sonnet',
  'convention-reviewer': 'sonnet',
  'e2e-test-generator': 'sonnet',
  'explain-diff-generator': 'sonnet',
  'feedback-interpreter': 'sonnet',
  implementer: 'sonnet',
  'japanese-coding-specialist': 'sonnet',
  'loop-eval-grader': 'sonnet',
  'qa-explorer': 'sonnet',
  'qa-goal-evaluator': 'sonnet',
  'qa-technical-evaluator': 'sonnet',
  'qa-ux-evaluator': 'sonnet',
  'requirement-coverage-checker': 'sonnet',
  'security-tester': 'sonnet',
  'simplify-reviewer': 'sonnet',
  'stop-judge': 'sonnet',
  'tdd-implementer': 'sonnet',
  'test-ledger-writer': 'sonnet',
  'test-spec-walker': 'sonnet',
  'test-writer': 'sonnet',
};

const read = (p) => fs.readFileSync(p, 'utf8');
const workflowFiles = () => fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.workflow.js')).sort();

// src の各位置が「コード」（文字列・コメントの外）かどうか。テンプレートの ${...} の中はコードに戻る。
// 行単位で `//` を探すと、同じ行の文字列に `http://` があるだけで呼び出しを取りこぼす。
function codeMask(src) {
  const mask = new Uint8Array(src.length);
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); i++; continue; }
      if (ch === '$' && src[i + 1] === '{') { stack.push('${'); mask[i] = mask[i + 1] = 1; i += 2; continue; }
      i++; continue;
    }
    if (top === "'" || top === '"') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === top) stack.pop();
      i++; continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (ch === '`' || ch === "'" || ch === '"') { stack.push(ch); i++; continue; }
    mask[i] = 1;
    if (ch === '{') stack.push('{');
    else if (ch === '}' && (top === '{' || top === '${')) stack.pop();
    i++;
  }
  return mask;
}

// 呼び出しの最後のトップレベル引数（opts は常に最後に渡している）を返す。
function readLastCallArg(src, mask, openIdx) {
  let depth = 0;
  let lastArgStart = openIdx + 1;
  for (let i = openIdx; i < src.length; i++) {
    if (!mask[i]) continue;
    const ch = src[i];
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) {
      depth--;
      if (depth === 0) return src.slice(lastArgStart, i).trim();
    } else if (ch === ',' && depth === 1) lastArgStart = i + 1;
  }
  throw new Error(`閉じ括弧が見つからない（offset ${openIdx}）`);
}

// opts のトップレベルだけを残す（文字列・入れ子・コメントを落とす）。プロンプト由来の文字列や
// 入れ子のオブジェクトに `agentType:` が現れても、それを opts のキーと取り違えないため。
function topLevelOf(opts) {
  const mask = codeMask(opts);
  let out = '';
  let depth = 0;
  for (let i = 0; i < opts.length; i++) {
    if (!mask[i]) continue;
    const ch = opts[i];
    if ('({['.includes(ch)) { depth++; continue; }
    if (')}]'.includes(ch)) { depth--; continue; }
    if (depth === 1) out += ch;
  }
  return out;
}

// schemaAgent の定義本体の範囲。本体の中の agent(prompt, opts) は opts を中継しているだけで呼び出し元ではない。
function schemaAgentBody(src, mask) {
  const def = /async\s+function\s+schemaAgent\s*\(/.exec(src);
  if (!def) return null;
  let i = src.indexOf('{', def.index);
  while (i >= 0 && !mask[i]) i = src.indexOf('{', i + 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (!mask[j]) continue;
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return [i, j];
  }
  throw new Error('schemaAgent の本体の終わりが見つからない');
}

function extractCalls(file) {
  const src = read(path.join(WORKFLOWS_DIR, file));
  const mask = codeMask(src);
  const body = schemaAgentBody(src, mask);
  const calls = [];
  // 識別子と括弧の間の空白も許す。拾えない書き方があると、その呼び出しは分類検査を無音ですり抜ける
  const re = /\b(agent|schemaAgent)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!mask[m.index]) continue;
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const opts = readLastCallArg(src, mask, m.index + m[0].length - 1);
    const line = src.slice(0, m.index).split('\n').length;
    if (body && m.index > body[0] && m.index < body[1] && opts === 'opts') continue;
    const labelMatch = opts.match(/label:\s*(['`])([^'`]*)\1/);
    calls.push({
      line,
      opts,
      top: topLevelOf(opts),
      label: labelMatch ? labelMatch[2].replace(/\$\{[^}]*\}/g, '*') : null,
    });
  }
  return calls;
}

test('すべての workflow が判断役の表に登録されている', () => {
  assert.deepEqual(workflowFiles(), Object.keys(JUDGMENT_LABELS).sort());
});

for (const file of workflowFiles()) {
  const judgment = new Set(JUDGMENT_LABELS[file] ?? []);

  test(`${file}: CHORE_MODEL は sonnet に固定されている`, () => {
    assert.match(read(path.join(WORKFLOWS_DIR, file)), /^const CHORE_MODEL = 'sonnet'$/m);
  });

  test(`${file}: すべての agent() 呼び出しがモデルの振り分けに分類されている`, () => {
    const calls = extractCalls(file);
    assert.ok(calls.length >= 20, `呼び出しの抽出件数が少なすぎる（${calls.length}件）。抽出器が壊れている`);
    for (const c of calls) {
      const where = `${file}:${c.line} label=${c.label}`;
      assert.ok(c.opts.startsWith('{'), `${where}: opts オブジェクトが最後の引数に無い（変数で渡すと分類を検査できない）`);
      assert.ok(c.label, `${where}: label が無い。分類できないので label を付ける`);
      if (/\bagentType\s*:/.test(c.top)) {
        // 呼び出し側の model は agent 定義の frontmatter より優先される（実走で確認）。
        // ここで指定すると EXPECTED_AGENT_MODELS の固定が効かなくなる
        assert.doesNotMatch(c.top, /\bmodel\s*:/, `${where}: agentType 付きの呼び出しに model が指定されている`);
        continue;
      }
      if (judgment.has(c.label)) {
        assert.doesNotMatch(c.opts, /\bmodel\s*:/, `${where}: 判断役にモデルが指定されている`);
        continue;
      }
      assert.match(c.top, /\bmodel:\s*CHORE_MODEL\b/, `${where}: 雑務なのに model: CHORE_MODEL が無い（メインの Opus で走る）`);
    }
  });

  test(`${file}: 判断役の表がすべて実在する`, () => {
    // 呼び出しを消したのに表に残ると、同名で足した雑務が素通りする
    const labels = new Set(extractCalls(file).map((c) => c.label));
    for (const l of judgment) assert.ok(labels.has(l), `${file}: 判断役 ${l} が見つからない`);
  });
}

test('すべての agent のモデル指定が期待表どおり', () => {
  const actual = {};
  for (const f of fs.readdirSync(AGENTS_DIR).filter((n) => n.endsWith('.md'))) {
    const fm = read(path.join(AGENTS_DIR, f)).split(/^---$/m)[1] ?? '';
    const m = fm.match(/^model:\s*(\S+)\s*$/m);
    actual[path.basename(f, '.md')] = m ? m[1] : null;
  }
  assert.deepEqual(actual, EXPECTED_AGENT_MODELS);
});

test('auto-build / auto-feedback の supervisor_model の記述が生成役と同じ Sonnet を例に挙げていない', () => {
  for (const skill of ['auto-build', 'auto-feedback']) {
    const lines = read(path.join(SKILLS_DIR, skill, 'SKILL.md')).split('\n').filter((l) => l.includes('supervisor_model'));
    assert.ok(lines.length > 0, `${skill}: supervisor_model の記述が無い`);
    for (const line of lines) {
      assert.doesNotMatch(line, /['"`](claude-)?sonnet[^'"`]*['"`]/i, `${skill}: implementer と同じ Sonnet を例に挙げている: ${line.trim()}`);
    }
  }
});
