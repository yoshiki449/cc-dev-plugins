#!/usr/bin/env node
'use strict';

// latest-handover.sh のテスト。
// 実行: node --test plugins/dev-flow/skills/_shared/scripts/latest-handover.test.js
//
// 「最新」の判定はファイル名の日付で行う。mtime ではない理由は、dev-setup B1-3 が
// .agent/ を worktree へコピーする経路を持っており、コピー後は全ファイルの mtime が
// ほぼ同時刻に揃って順序が不定になるため。生成側 new-handover-path.sh が必ず
// handover-YYYYMMDD-HHMM を作るので、ファイル名は信頼できる。
//
// AC2/AC3/AC5 は Issue #52 の回帰。旧実装（ls | sort | tail -1）は辞書順なので、
// 日付を持たない handover-257.md や handover-issue62.md が常に最後に来て
// 「最新」として返っていた。この3件は旧実装に戻すと必ず落ちる。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'latest-handover.sh');

/** .agent/ に files を置いた一時ディレクトリを作る。files は名前の配列。 */
function fixture(files, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-handover-'));
  if (!opts.noAgentDir) {
    fs.mkdirSync(path.join(dir, '.agent'));
    for (const f of files) {
      fs.writeFileSync(path.join(dir, '.agent', f), `# ${f}\n`);
    }
  }
  return dir;
}

/** mtime を明示的にずらす（epoch 秒で指定）。 */
function setMtime(dir, name, epochSec) {
  const p = path.join(dir, '.agent', name);
  fs.utimesSync(p, epochSec, epochSec);
}

function run(dir) {
  const r = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    // 返ったパスの basename。空文字なら ''
    name: r.stdout.trim() ? path.basename(r.stdout.trim()) : '',
  };
}

test('AC1: 日付命名だけなら日付が最新のものを返す', () => {
  const dir = fixture([
    'handover-20260817-1007-issue34.md',
    'handover-20260820-1738-issue259.md',
    'handover-20260708-1326-issue12.md',
  ]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.name, 'handover-20260820-1738-issue259.md');
  assert.equal(r.stderr, '', '日付なしが無ければ警告は出さない');
});

test('AC2: handover-257.md（数字のみ）が混在しても日付命名の最新を返す', () => {
  // 辞書順では handover-257.md が handover-2026... より後ろに来る（'5' > '0'）。
  // 業務リポジトリの worktree 2箇所で実在した構成。
  const dir = fixture([
    'handover-20260820-1348-issue259.md',
    'handover-20260820-1738-issue259.md',
    'handover-257.md',
  ]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.name, 'handover-20260820-1738-issue259.md');
});

test('AC3: handover-issue62.md（旧命名）が混在しても日付命名の最新を返す', () => {
  // 辞書順では 'i' > '2' なので旧命名が必ず最後に来る。
  // 業務リポジトリ2つの計6ディレクトリで実在した構成。
  const dir = fixture([
    'handover-20260820-1738-issue259.md',
    'handover-issue55.md',
    'handover-issue59.md',
    'handover-issue62.md',
  ]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.name, 'handover-20260820-1738-issue259.md');
});

test('AC4: 同じ日付なら時刻が新しい方を返す', () => {
  const dir = fixture([
    'handover-20260825-1518-issue45.md',
    'handover-20260825-1926-issue45.md',
    'handover-20260825-1723-issue45.md',
  ]);
  assert.equal(run(dir).name, 'handover-20260825-1926-issue45.md');
});

test('AC5: 同じ日付で時刻ありと時刻なしが並んだら、時刻ありを新しいとみなす', () => {
  // handover-20260817-issue34-phase2.md は時刻を持たない実在の命名。
  // 辞書順だと 'i' > '1' で時刻なしが後ろに来るため、旧実装はこれを返していた。
  const dir = fixture([
    'handover-20260817-issue34-phase2.md',
    'handover-20260817-1627-issue34-phase3.md',
  ]);
  assert.equal(run(dir).name, 'handover-20260817-1627-issue34-phase3.md');
});

test('AC6: 日付を持つものが1件も無ければ mtime 最新を返し、代替である旨を stderr に出す', () => {
  const dir = fixture([
    'handover-issue55.md',
    'handover-issue59.md',
    'handover-issue62.md',
  ]);
  setMtime(dir, 'handover-issue55.md', 1000000);
  setMtime(dir, 'handover-issue59.md', 3000000); // 最新
  setMtime(dir, 'handover-issue62.md', 2000000);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.name, 'handover-issue59.md');
  assert.match(r.stderr, /更新時刻/, '日付で判定できなかったことを伝える');
});

test('AC7: 日付なしを無視したときは件数を stderr に出す', () => {
  const dir = fixture([
    'handover-20260820-1738-issue259.md',
    'handover-257.md',
    'handover-issue62.md',
  ]);
  const r = run(dir);
  assert.equal(r.name, 'handover-20260820-1738-issue259.md');
  // 件数は数字だけを見ない。stderr には除外したファイル名も載るため、
  // /2/ だと handover-257.md の '2' に当たって件数が 999 でも通る（実測済み）。
  assert.match(r.stderr, /日付を持たない引継書 2 件/, '無視した件数そのものを報告する');
});

test('AC8: stdout はパス1行のみ（警告が stdout に混ざらない）', () => {
  // 呼び出し側6箇所はすべて $(...) で受けるため、stdout が汚れると壊れる。
  const dir = fixture([
    'handover-20260820-1738-issue259.md',
    'handover-issue62.md',
  ]);
  const r = run(dir);
  // endsWith では 'WARN: ...\n.agent/handover-...md' のように警告が先頭へ混入しても
  // 通ってしまう。$(...) 側が複数行を受け取る壊れ方なので全体を固定する。
  assert.equal(r.stdout, '.agent/handover-20260820-1738-issue259.md\n');
});

test('AC9: .agent/ が無ければ空文字・exit 0・stderr も空', () => {
  const dir = fixture([], { noAgentDir: true });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(r.stderr, '');
});

test('AC10: .agent/ はあるが引継書が無ければ空文字・exit 0', () => {
  const dir = fixture([]);
  fs.writeFileSync(path.join(dir, '.agent', 'knowledge.md'), 'x\n');
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(r.stderr, '');
});

test('AC11: 返すパスは実在し、.agent/ 配下を指す', () => {
  const dir = fixture(['handover-20260820-1738-issue259.md']);
  const r = run(dir);
  const out = r.stdout.trim();
  assert.ok(out.includes('.agent/'), `.agent/ を含むこと: ${out}`);
  assert.ok(fs.existsSync(path.join(dir, out)), `cwd 相対で実在すること: ${out}`);
});

test('AC12: 日付キーが同じなら、パスの辞書順で後ろのものを返す', () => {
  // 時刻なしが同日に2件ある異常系。どちらも key は 202608170000 になる。
  //
  // 「3回実行して同じ結果」では何も検証できない。sort もグロブも決定的なので、
  // どんな実装でも通る（敵対的検証が指摘・実測）。勝者を名指しして順序規則を固定する。
  // phase2 が勝つのは、タブ区切りの第2フィールド（パス）の辞書順で '2' > '1' のため。
  const dir = fixture([
    'handover-20260817-issue34-phase15.md',
    'handover-20260817-issue34-phase2.md',
  ]);
  assert.equal(run(dir).name, 'handover-20260817-issue34-phase2.md');
});

test('AC13: 日付なしが多数あっても exit 0 で1件だけ返す（SIGPIPE 回帰）', () => {
  // フォールバックを `ls -1t ... | head -n 1` で書くと、pipefail 下で head が先に閉じた
  // ときに ls が SIGPIPE で落ち、パイプライン全体が exit 141 になる。set -e と合わさって
  // スクリプトが無音停止し、呼び出し元の extract-issue-number.sh まで連鎖する。
  // 3000件は実測で 5/5 再現した件数（旧実装 exit=141 / 新実装 exit=0）。
  const names = [];
  for (let i = 0; i < 3000; i++) names.push(`handover-issue${i}.md`);
  const dir = fixture(names);
  const r = run(dir);
  assert.equal(r.status, 0, `SIGPIPE で落ちてはいけない: exit=${r.status}`);
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, '返すのは1件だけ');
  assert.match(r.stderr, /更新時刻/);
});

test('AC14: Issue 番号なしの handover-YYYYMMDD-HHMM.md（日付時刻の直後がドット）も時刻まで読む', () => {
  // new-handover-path.sh は Issue 番号が渡されないとこの形式を作る（生成側の正規の命名）。
  // 正規表現の終端 [-.] から '.' を落とすと、この名前だけ時刻が捨てられて 0000 に落ち、
  // 同じ日の古い引継書に負ける。既存12ケースはどれもこの分岐を通らないため、
  // '.' を消しても全部グリーンのまま誤答するのを敵対的検証が実測した。
  const dir = fixture([
    'handover-20260901-1800.md',          // Issue 番号なし。これが最新
    'handover-20260901-0900-issue1.md',
  ]);
  assert.equal(run(dir).name, 'handover-20260901-1800.md');
});

test('AC15: 第1引数で対象ディレクトリを指定できる（ヘッダが公開している [dir]）', () => {
  // 呼び出し元6箇所はすべて引数なし（cwd）で呼ぶが、ヘッダが `latest-handover.sh [dir]` と
  // 公開している以上、引数経路にも回帰が要る。cd を消しても cwd 実行では気づけない。
  const dir = fixture(['handover-20260820-1738-issue259.md', 'handover-issue62.md']);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-handover-elsewhere-'));
  const r = spawnSync('bash', [SCRIPT, dir], { cwd: other, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '.agent/handover-20260820-1738-issue259.md\n');
});

test('AC16: 時刻なしの handover-YYYYMMDD.md（日付の直後がドット）も日付として読む', () => {
  // AC14 は時刻ありの `.` 分岐（regex1）を固定した。regex2（時刻なし）にも同じ形の
  // 穴があり、こちらだけ塞がずにいると `^handover-([0-9]{8})[-.]` から '.' を落とす
  // 変異が素通りする。片方を塞いだら対称に塞ぐ。
  const dir = fixture([
    'handover-20260901.md',               // 時刻なし・ドット直後。これが最新
    'handover-20260831-2300-issue1.md',
  ]);
  assert.equal(run(dir).name, 'handover-20260901.md');
});

test('AC17: .md 以外の拡張子（エディタのバックアップ等）は候補に入れない', () => {
  // グロブを `.agent/handover-*` に緩める変異を検知する。引継書を編集した直後に
  // .bak / .orig が残っていると、そちらが「最新」として返る壊れ方になる。
  const dir = fixture([
    'handover-20260820-1738-issue259.md',
    'handover-20260901-1800.md.bak',
    'handover-20260901-1800.md.orig',
  ]);
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '.agent/handover-20260820-1738-issue259.md\n');
});
