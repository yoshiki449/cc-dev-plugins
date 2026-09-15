import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractTitles } from './extract-test-titles.mjs';

const SCRIPT = fileURLToPath(new URL('./extract-test-titles.mjs', import.meta.url));

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-titles-'));
}

function runCli(args, opts = {}) {
  return execFileSync('node', [opts.script || SCRIPT, ...args], { encoding: 'utf8', ...opts });
}

test('extractTitles: describe / test / it を種別と行番号つきで抽出する', () => {
  const src = [
    "import { test } from '@playwright/test';", // 1
    '', // 2
    "test.describe('シナリオ: 面談記録の登録', () => {", // 3
    "  test('面談記録を登録できること', async ({ page }) => {});", // 4
    "  it('空欄なら登録できないこと', () => {});", // 5
    '});', // 6
  ].join('\n');

  assert.deepEqual(extractTitles(src), [
    { kind: 'describe', title: 'シナリオ: 面談記録の登録', line: 3 },
    { kind: 'test', title: '面談記録を登録できること', line: 4 },
    { kind: 'it', title: '空欄なら登録できないこと', line: 5 },
  ]);
});

test('extractTitles: 修飾子つき・各種クォート・エスケープを扱う', () => {
  const src = [
    "test.only('のみ実行', () => {});",
    'test.skip(`テンプレートリテラル`, () => {});',
    'describe.each([1])("パラメータ %i", () => {});',
    "test('エスケープ\\'込み', () => {});",
  ].join('\n');

  assert.deepEqual(extractTitles(src), [
    { kind: 'test', title: 'のみ実行', line: 1 },
    { kind: 'test', title: 'テンプレートリテラル', line: 2 },
    { kind: 'describe', title: 'パラメータ %i', line: 3 },
    { kind: 'test', title: "エスケープ'込み", line: 4 },
  ]);
});

test('extractTitles: タイトルが空・非該当なら拾わない', () => {
  assert.deepEqual(extractTitles("test('', () => {});"), []);
  assert.deepEqual(extractTitles('const tested = 1;'), []);
  assert.deepEqual(extractTitles("myTest('これは対象外', () => {});"), []);
});

test('CLI: リポジトリ全走査で spec を JSON 出力し、node_modules を除外する', () => {
  const repo = mkTmp();
  fs.mkdirSync(path.join(repo, 'e2e'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'e2e', 'login.spec.ts'), "test('ログインできること', () => {});");
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'a.spec.js'), "test('拾ってはいけない', () => {});");
  fs.writeFileSync(path.join(repo, 'src.ts'), "test('specでないので対象外', () => {});");

  const out = JSON.parse(runCli(['--repo', repo]));
  assert.deepEqual(out, {
    files: [{ file: 'e2e/login.spec.ts', titles: [{ kind: 'test', title: 'ログインできること', line: 1 }] }],
  });
});

test('CLI: 対象0件でも exit 0 だが stderr に警告を出す（無音成功を禁止）', () => {
  const repo = mkTmp();
  const stderrPath = path.join(repo, 'stderr.txt');
  const fd = fs.openSync(stderrPath, 'w');
  const stdout = runCli(['--repo', repo], { stdio: ['ignore', 'pipe', fd] });
  fs.closeSync(fd);

  assert.deepEqual(JSON.parse(stdout), { files: [] });
  assert.match(fs.readFileSync(stderrPath, 'utf8'), /WARNING/);
});

test('CLI: symlink 経由で起動しても main() が走る（無音 exit 0 の回帰テスト）', () => {
  const dir = mkTmp();
  const link = path.join(dir, 'linked.mjs');
  fs.symlinkSync(SCRIPT, link);

  const repo = mkTmp();
  fs.writeFileSync(path.join(repo, 'a.spec.ts'), "test('symlink経由でも動くこと', () => {});");

  const out = JSON.parse(runCli(['--repo', repo], { script: link }));
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].titles[0].title, 'symlink経由でも動くこと');
});

test('CLI: --repo 未指定は exit 2', () => {
  assert.throws(() => runCli([], { stdio: 'pipe' }), (err) => err.status === 2);
});

test('extractTitles: pytest の def test_xxx() をトップレベル関数として抽出する', () => {
  const src = [
    'import pytest', // 1
    '', // 2
    'def test_forgot_password_success(client):', // 3
    '    assert True', // 4
    '', // 5
    'async def test_async_flow(client):', // 6
    '    assert True', // 7
  ].join('\n');

  assert.deepEqual(extractTitles(src, 'tests/test_password_reset.py'), [
    { kind: 'test', title: 'test_forgot_password_success', line: 3 },
    { kind: 'test', title: 'test_async_flow', line: 6 },
  ]);
});

test('extractTitles: pytest の class TestXxx 配下の def test_yyy をメソッドとして抽出する', () => {
  const src = [
    'class TestBuildFieldErrors:', // 1
    '    def test_returns_empty_list(self):', // 2
    '        assert True', // 3
    '', // 4
    '    def test_returns_error(self, client):', // 5
    '        assert True', // 6
    '', // 7
    'class TestAppError(unittest.TestCase):', // 8
    '    def test_message(self):', // 9
    '        assert True', // 10
  ].join('\n');

  assert.deepEqual(extractTitles(src, 'tests/test_error_handlers.py'), [
    { kind: 'describe', title: 'TestBuildFieldErrors', line: 1 },
    { kind: 'test', title: 'test_returns_empty_list', line: 2 },
    { kind: 'test', title: 'test_returns_error', line: 5 },
    { kind: 'describe', title: 'TestAppError', line: 8 },
    { kind: 'test', title: 'test_message', line: 9 },
  ]);
});

test('extractTitles: filename 未指定・.py 以外は従来どおり describe/test/it 構文を使う（後方互換）', () => {
  assert.deepEqual(extractTitles("test('従来どおり', () => {});"), [
    { kind: 'test', title: '従来どおり', line: 1 },
  ]);
  assert.deepEqual(extractTitles("test('従来どおり', () => {});", 'e2e/login.spec.ts'), [
    { kind: 'test', title: '従来どおり', line: 1 },
  ]);
});

test('extractTitles: .py でも def test_ / class Test に該当しなければ拾わない', () => {
  assert.deepEqual(extractTitles('def helper():\n    pass\n\nclass Helper:\n    pass', 'tests/conftest.py'), []);
});

test('CLI: 先頭 test_ 形式の pytest ファイル（全走査）を拾う', () => {
  const repo = mkTmp();
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'tests', 'test_auth.py'),
    'def test_login_success(client):\n    assert True\n',
  );
  // pytest の対象外: test_ で始まらないヘルパーファイル
  fs.writeFileSync(path.join(repo, 'tests', 'conftest.py'), 'def fixture_helper():\n    pass\n');

  const out = JSON.parse(runCli(['--repo', repo]));
  assert.deepEqual(out, {
    files: [
      {
        file: 'tests/test_auth.py',
        titles: [{ kind: 'test', title: 'test_login_success', line: 1 }],
      },
    ],
  });
});

test('CLI: --diff 指定でも先頭 test_ 形式の pytest ファイルを拾う', () => {
  const repo = mkTmp();
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'init');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: repo });

  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'tests', 'test_new_feature.py'),
    'def test_new_behavior(client):\n    assert True\n',
  );
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '--quiet', '-m', 'add test'], { cwd: repo });

  const out = JSON.parse(runCli(['--repo', repo, '--diff', 'HEAD~1...HEAD']));
  assert.deepEqual(out, {
    files: [
      {
        file: 'tests/test_new_feature.py',
        titles: [{ kind: 'test', title: 'test_new_behavior', line: 1 }],
      },
    ],
  });
});

test('CLI: 全走査で Python 仮想環境・キャッシュ配下のベンダーテストを拾わない', () => {
  const repo = mkTmp();
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'tests', 'test_app.py'),
    'def test_own_behavior(client):\n    assert True\n',
  );

  fs.mkdirSync(path.join(repo, '.venv', 'lib', 'pkg', 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.venv', 'lib', 'pkg', 'tests', 'test_vendor.py'),
    'def test_vendor_should_not_be_collected():\n    assert True\n',
  );
  fs.mkdirSync(path.join(repo, 'venv', 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'venv', 'tests', 'test_vendor2.py'),
    'def test_vendor2_should_not_be_collected():\n    assert True\n',
  );
  fs.mkdirSync(path.join(repo, '__pycache__'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '__pycache__', 'test_cache.py'),
    'def test_cache_should_not_be_collected():\n    assert True\n',
  );

  const out = JSON.parse(runCli(['--repo', repo]));
  assert.deepEqual(out, {
    files: [
      {
        file: 'tests/test_app.py',
        titles: [{ kind: 'test', title: 'test_own_behavior', line: 1 }],
      },
    ],
  });
});

test('extractTitles: 他関数にネストされた test_ 関数と、Test で始まらないクラスの test_ メソッドは現状拾ってしまう（既知の限界・回帰固定）', () => {
  const src = [
    'def test_outer():', // 1
    '    def test_inner_helper():', // 2
    '        assert True', // 3
    '    test_inner_helper()', // 4
    '', // 5
    'class Helper:', // 6
    '    def test_inside_non_test_class(self):', // 7
    '        assert True', // 8
  ].join('\n');

  // pytest 自身はネストされた関数・Test で始まらないクラスのメソッドを収集しないが、
  // このスクリプトは正規表現ベースで行頭パターンのみを見るため区別できない（AST 化はスコープ外）。
  assert.deepEqual(extractTitles(src, 'tests/test_nested.py'), [
    { kind: 'test', title: 'test_outer', line: 1 },
    { kind: 'test', title: 'test_inner_helper', line: 2 },
    { kind: 'test', title: 'test_inside_non_test_class', line: 7 },
  ]);
});
