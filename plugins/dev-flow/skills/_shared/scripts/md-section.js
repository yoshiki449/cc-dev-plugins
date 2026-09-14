'use strict';

// md を検査するテストのための共通ヘルパー。
//
// なぜ共有するか: この関数は「実測で見つけた2つの欠陥」の対策そのもので、
// 複製すると片方だけ直したときに**節境界の欠陥がもう片方で復活する**。
// 実際、切り出す前は agents/e2e-test-generator.test.js と
// skills/_shared/scripts/skill-md-gate-tables.test.js にコメント込みで
// バイト単位の複製が置かれていた。

const assert = require('node:assert');

/**
 * `<見出し>` から次の同レベル以上の見出しまでを切り出す。節の外にある記述を誤って数えないため。
 *
 * ⚠ `md.slice(indexOf(A), indexOf(B))` で書かないこと。終端見出し B が改名されると
 *    `indexOf` が -1 を返してスライスが**文書末尾まで伸び**、節に限定したはずの検査が
 *    静かに whole-file 照合に戻る。長さガード（length > N）はむしろ通りやすくなるので
 *    形骸化に気づけない（レンズ A m-6）。
 */
function section(md, heading) {
  const start = md.indexOf(heading);
  assert.notStrictEqual(start, -1, `「${heading}」節が見つからない`);
  const depth = heading.match(/^#+/)[0].length;
  const rest = md.slice(start + heading.length);
  // コードフェンスの中の `# コメント` を見出しと誤認しない。実測: E1.2 節の bash ブロックに
  // `# <REPO_ROOT> は …` があり、素の検索だと節がそこで切れて実行式が範囲外に落ちた。
  // マスクは1文字を1スペースに置換して**長さを保つ**ので、位置は原文と一致する。
  const masked = rest.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
  const end = masked.search(new RegExp(`\\n#{1,${depth}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

module.exports = { section };
