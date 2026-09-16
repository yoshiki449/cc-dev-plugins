// 実行: node --test plugins/dev-flow/skills/cloud-env-setup/scripts/render_qc_overlay_snippet.test.mjs
//
// クラウド VM は $HOME がセッションごとにリセットされるため、ローカルの overlay 配置
// （組織側 plugin の install_overlay.py）はクラウドには届かない。このスクリプトは overlay
// ファイルの中身を Setup script 用の heredoc スニペットに変換する。生成物を実際に bash
// 実行して元ファイルとバイト単位で一致することを確認するのが本体のテスト。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render_qc_overlay_snippet.sh');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function render(overlayDir, args = []) {
  return spawnSync('bash', [SCRIPT, '--overlay-dir', overlayDir, ...args], { encoding: 'utf8' });
}

// 生成されたスニペットを別の一時 $HOME で実際に実行し、~/.cc-plugins/overlay/qc/ を返す
function apply(snippet) {
  const home = tempDir('render-qc-home-');
  const r = spawnSync('bash', ['-c', snippet], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, `生成したスニペットの実行が失敗した: ${r.stderr}`);
  return path.join(home, '.cc-plugins', 'overlay', 'qc');
}

function writeOverlay(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

test('overlay ディレクトリが無いとエラー終了し、stdout は空', () => {
  const dir = path.join(tempDir('render-qc-missing-'), 'does-not-exist');
  const r = render(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /overlay が見つからない/);
});

test('overlay ディレクトリはあるが対象ファイルが1つも無いとエラー終了', () => {
  const dir = tempDir('render-qc-empty-');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'これは対象外のファイル');
  const r = render(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('存在するファイルだけ出力し、無いフェーズは出力しない', () => {
  const src = tempDir('render-qc-partial-');
  writeOverlay(src, {
    'manifest.json': '{"name":"test","version":"1.0.0","reviewer_agent":"acme:qc-reviewer"}\n',
    'plan.md': '- 観点1\n- 観点2\n',
  });
  const r = render(src);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /manifest\.json/);
  assert.match(r.stdout, /plan\.md/);
  for (const absent of ['impl.md', 'test-spec.md', 'verify.md', 'qa.md', 'ship.md', 'test-model.md']) {
    assert.doesNotMatch(r.stdout, new RegExp(absent.replace('.', '\\.')));
  }
});

test('往復性: 生成したスニペットを実行すると元ファイルとバイト単位で一致する（改行・バックスラッシュ・バックティック・$・日本語を含む）', () => {
  const src = tempDir('render-qc-roundtrip-');
  const files = {
    'manifest.json': '{"name":"テスト overlay","version":"1.0.0","reviewer_agent":"acme:qc-reviewer"}\n',
    'plan.md': [
      '# 計画観点',
      '',
      '- バックスラッシュ: C:\\path\\to\\file',
      '- バックティック: `echo hi`',
      '- 変数っぽい文字列: $HOME や ${FOO}',
      '- 日本語の観点も含む',
      '',
    ].join('\n'),
    'ship.md': '末尾に改行の無いファイル', // 末尾改行なし。かつ FOUND 配列内で最後の要素ではないことを
    'test-model.md': '- 末尾改行ありのファイルが後に続く\n', // 確認するため、これより後ろにもう1件置く
  };
  writeOverlay(src, files);

  const r = render(src);
  assert.equal(r.status, 0, r.stderr);

  const destDir = apply(r.stdout);
  for (const [name, content] of Object.entries(files)) {
    const actual = fs.readFileSync(path.join(destDir, name));
    assert.deepEqual(actual, Buffer.from(content, 'utf8'), `${name} が元ファイルと一致しない`);
  }
});

test('空ファイルも0バイトのまま再現する', () => {
  const src = tempDir('render-qc-emptyfile-');
  writeOverlay(src, { 'manifest.json': '', 'qa.md': '- 観点\n' });
  const r = render(src);
  assert.equal(r.status, 0, r.stderr);
  const destDir = apply(r.stdout);
  assert.equal(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8'), '');
});

test('デリミタと衝突する行を含むファイルは、壊れた出力を返さずエラー終了する', () => {
  // 「わざと壊す」テスト: QC_OVERLAY_EOF という行がそのまま含まれると、
  // シングルクオート heredoc でもその行で早期終端し、出力が黙って壊れる。
  const src = tempDir('render-qc-collision-');
  writeOverlay(src, {
    'manifest.json': '{}\n',
    'plan.md': '- 観点1\nQC_OVERLAY_EOF\n- 観点2（本当はここまで書きたい）\n',
  });
  const r = render(src);
  assert.equal(r.status, 1, '衝突を検知できていない（出力が壊れたまま通っている）');
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /衝突/);
});

test('manifest.json が無いとエラー終了する（フェーズファイルだけあっても貼り付け先で全滅するため）', () => {
  // わざと壊すテスト: manifest.json を欠いたまま生成すると、貼り付け先の qc-overlay.sh は
  // 全フェーズ overlay_applied=0 を返す。生成・貼り付けが「成功したように見える」のに
  // QC観点が1つも効いていない状態を、生成の時点で止める。
  const src = tempDir('render-qc-nomanifest-');
  writeOverlay(src, { 'plan.md': '- 観点1\n', 'impl.md': '- 観点2\n' });
  const r = render(src);
  assert.equal(r.status, 1, 'manifest.json 欠落を検知できていない');
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /manifest\.json/);
});

test('--overlay-dir に値を渡さないと exit 2 になる（生の unbound variable エラーにしない）', () => {
  const r = spawnSync('bash', [SCRIPT, '--overlay-dir'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /未割り当ての変数|unbound variable/);
});

test('ディレクトリと各ファイルの chmod/mkdir が出力に含まれる', () => {
  const src = tempDir('render-qc-chmod-');
  writeOverlay(src, { 'manifest.json': '{}\n' });
  const r = render(src);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mkdir -p -m 700 ~\/\.cc-plugins\/overlay\/qc/);
  assert.match(r.stdout, /chmod 600 ~\/\.cc-plugins\/overlay\/qc\/manifest\.json/);
});

test('CC_PLUGINS_OVERLAY_DIR より --overlay-dir が優先される', () => {
  const envDir = tempDir('render-qc-env-');
  const argDir = tempDir('render-qc-arg-');
  writeOverlay(envDir, { 'manifest.json': '{"from":"env"}\n' });
  writeOverlay(argDir, { 'manifest.json': '{"from":"arg"}\n' });
  const r = spawnSync('bash', [SCRIPT, '--overlay-dir', argDir], {
    encoding: 'utf8',
    env: { ...process.env, CC_PLUGINS_OVERLAY_DIR: envDir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"from":"arg"/);
  assert.doesNotMatch(r.stdout, /"from":"env"/);
});

test('2回実行しても出力が同一（冪等）', () => {
  const src = tempDir('render-qc-idempotent-');
  writeOverlay(src, { 'manifest.json': '{}\n', 'plan.md': '- 観点\n' });
  const first = render(src).stdout;
  const second = render(src).stdout;
  assert.equal(first, second);
});
