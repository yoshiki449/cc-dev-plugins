#!/usr/bin/env node
'use strict';

// このリポジトリが公開に耐える状態を保っているかの検査。
// 実行: node --test plugins/cc-meta/scripts/repo-hygiene.test.js
//
// 経緯は cc-dev-plugins#1。cc-plugins から plugin を移したとき、作成者のホーム配下の
// 絶対パスと個人の作業ディレクトリ名が 5 ファイル・13 行そのまま来ていた。
// 公開前ゲート（publish-scan.sh）は denylist をリポジトリ外に置くので、
// **このリポジトリ単体では何も守れない**。denylist を持たない環境で clone した人にも
// 効く検査が要る。落ちる方向が悪く、見逃すと他人の環境で動かないまま公開される。

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..');

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function readText(rel) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(REPO, rel));
  } catch {
    return null;
  }
  if (buf.includes(0)) return null; // バイナリ
  return buf.toString('utf8');
}

test('AC1: 番号付きの個人フォルダ名が残っていない', () => {
  // 作成者のホームは「2桁の数字・アンダースコア・名前」でディレクトリを切ってある。
  // この形はほぼ確実に個人の環境固有なので、名前を列挙せず形そのものを禁じる。
  // 特定の名前だけ並べると、別の番号フォルダが増えた時点で素通りする。
  // 実例をこのコメントに書かないのは、公開前ゲートがこのファイル自身で発火するため。
  const hits = [];
  for (const rel of trackedFiles()) {
    const body = readText(rel);
    if (body === null) continue;
    body.split('\n').forEach((line, i) => {
      const m = line.match(/(?:^|[/~])\d{2}_[A-Za-z][A-Za-z0-9_-]*/);
      if (m) hits.push(`${rel}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepStrictEqual(hits, [], '個人の作業ディレクトリ名が残っている');
});

test('AC2: 特定個人のホーム配下の絶対パスが残っていない', () => {
  // `/home/node` はコンテナの実行ユーザー、`/home/<user>` は規約の NG 例なので許す。
  // それ以外の名前が入っていたら、書いた人のローカル構成が出ている。
  const ALLOWED = new Set(['node', '<user>']);
  const hits = [];
  for (const rel of trackedFiles()) {
    const body = readText(rel);
    if (body === null) continue;
    body.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\/home\/([A-Za-z0-9_<>-]+)/g)) {
        if (!ALLOWED.has(m[1])) hits.push(`${rel}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepStrictEqual(hits, [], '個人ホーム配下の絶対パスが残っている');
});

test('AC3: .env.example が追跡され、実値を持たない', () => {
  // .gitignore の `.env.*` に食われて配布されないと、設定キーの存在自体が誰にも伝わらない。
  // 実際に一度その状態で書き上げた（`!.env.example` を足して解消）。
  assert.ok(trackedFiles().includes('.env.example'), '.env.example が tracked でない');

  // tracked になった後は .gitignore を戻しても既存ファイルには効かないので、
  // 「いま追跡されているか」だけでは除外の復活を検出できない。
  // 消して作り直した人が同じ穴に落ちるため、除外の打ち消しそのものを固定する。
  const ignore = readText('.gitignore');
  if (/^\.env\.\*$/m.test(ignore)) {
    assert.match(
      ignore,
      /^!\.env\.example$/m,
      '.env.* を除外したまま .env.example の打ち消しが無い',
    );
  }

  const body = readText('.env.example');
  for (const key of ['CC_DEV_PLUGINS_DIR', 'CC_PLUGINS_DIR']) {
    assert.ok(body.includes(key), `${key} がテンプレートに無い`);
  }

  const values = body
    .split('\n')
    .filter((l) => /^CC_[A-Z_]+=/.test(l))
    .map((l) => l.slice(l.indexOf('=') + 1));
  assert.ok(values.length >= 2, 'テンプレートに設定行が無い');
  for (const v of values) {
    assert.match(v, /^</, `実値らしきものが書かれている: ${v}`);
  }
});

test('AC4: cc-meta のコマンドが marketplace のパスを手順書に埋め込まない', () => {
  // パスを手順書に書くと、他の環境で動かないうえ、2本ある marketplace のどちらへ移植するかを
  // 選べなくなる。解決は marketplace_dirs.py の1箇所に寄せる。
  for (const name of ['promote-check.md', 'promote-skill.md']) {
    const rel = `plugins/cc-meta/commands/${name}`;
    const body = readText(rel);
    assert.ok(body, `${rel} が読めない`);
    assert.ok(
      body.includes('marketplace_dirs.py'),
      `${rel} が marketplace_dirs.py を経由していない`,
    );
    assert.ok(
      !/--cc-plugins\s+\/[A-Za-z]/.test(body),
      `${rel} が --cc-plugins に絶対パスを直書きしている`,
    );
  }

  // mark-keep はローカルにマーカーを書くだけなので marketplace のパスを使わない
  const markKeep = readText('plugins/cc-meta/commands/mark-keep.md');
  assert.ok(!markKeep.includes('--cc-plugins'), 'mark-keep がローカル専用でなくなっている');
});

test('AC5: 未判定一覧は marketplace を複数受け取れる', () => {
  // 片方だけを見ると、もう片方へ移植済みのスキルが「未判定」として出続ける。
  // 2本構成になった時点で単数の --cc-plugins は誤りになった。
  const src = readText(
    'plugins/cc-meta/skills/cc-plugins-promote/scripts/list_unpromoted.py',
  );
  assert.match(src, /action="append"/, '--cc-plugins が複数指定を受け付けない');
});

test('AC6: 移植先の marketplace に既定値を持たせない', () => {
  // 推測で選ぶと、業務固有のスキルが公開リポジトリへ入る経路になる。
  //
  // 「ソースに sys.exit(2) がある」では固定できない。別の箇所に残っていれば通るので、
  // 実際に未設定の環境で走らせて、止まることと標準出力が空であることを見る。
  const script = path.join(
    REPO,
    'plugins/cc-meta/skills/cc-plugins-promote/scripts/marketplace_dirs.py',
  );
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mkt-dirs-'));
  const env = { ...process.env, HOME: home };
  delete env.CC_DEV_PLUGINS_DIR;
  delete env.CC_PLUGINS_DIR;

  for (const args of [[], ['--key', 'public'], ['--key', 'private']]) {
    const r = require('node:child_process').spawnSync('python3', [script, ...args], {
      encoding: 'utf8',
      env,
    });
    assert.strictEqual(r.status, 2, `未設定なのに止まらない: ${args.join(' ') || '(引数なし)'}`);
    assert.strictEqual(r.stdout.trim(), '', '未設定なのにパスを出力した');
    assert.match(r.stderr, /未設定/, '止まった理由を言っていない');
  }

  // marketplace でないディレクトリを渡しても通さない
  const notRepo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'not-a-repo-'));
  const r2 = require('node:child_process').spawnSync(
    'python3',
    [script, '--key', 'public'],
    { encoding: 'utf8', env: { ...env, CC_DEV_PLUGINS_DIR: notRepo } },
  );
  assert.strictEqual(r2.status, 2, 'marketplace でないパスを受け入れた');
  assert.strictEqual(r2.stdout.trim(), '', 'marketplace でないパスを出力した');
});
