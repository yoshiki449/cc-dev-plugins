#!/usr/bin/env node
// dev-test-spec: テスト計画 JSON の静的リント（仕様書の記述精度チェック・第1段）
//
// 責務: plan JSON 単体で機械検出できる矛盾・抜け・揺れの検出のみ。
// 実画面との整合（ボタン名・画面遷移の実在）は第2段の実走検証
// （test-spec-walker エージェント）が担当する。機能バグの判定はどちらもしない。
//
// 使い方:
//   node lint-plan.mjs --plan .agent/test-spec-<機能名>.json
//   → [ERROR]/[WARN] を列挙。ERROR が1件でもあれば exit 1（シート生成に進まない）

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validatePlan } from './generate-requests.mjs';

// よくある表記揺れの辞書（同一グループ内の変種が2種類以上使われていたら警告）
// 長い変種を先に置くこと（部分文字列の誤カウント防止のため長い順に除去して数える）
export const VARIANT_GROUPS = [
  ['受け入れ企業', '受入れ企業', '受入企業'],
  ['受け入れ機関', '受入れ機関', '受入機関'],
  ['取り込み', '取込み', '取込'],
  ['ドロップダウン', 'プルダウン'],
  ['クリック', '押下'],
  ['サインイン', 'ログオン', 'ログイン'],
  ['モーダル', 'ダイアログ'],
  ['保存する', '登録する'],
];

// 文章規約（読者は非エンジニアのテスト実施者）の機械検出ルール。
// SKILL.md「手動テスト手順の文章規約」と対で運用する。すべて error（シート生成の前提条件）。
export const WORDING_RULES = [
  {
    code: 'wording-concept',
    // 数字は `+` で伸ばす（1桁で切ると指摘メッセージが「Step0」となり何を直せばよいか読めない）
    re: /\b(precondition|case\d+|Step\s*\d+|Group\s*\d{2,})/gi,
    hint: '手順の参照は「手順00 No.04」形式で書き、実装の概念名は使わないでください',
    label: '実装の概念名',
  },
  {
    code: 'wording-identifier',
    re: /\b[a-z]+[A-Z][A-Za-z]{3,}\b/g,
    hint: '非エンジニア向けの日本語に置き換えてください',
    label: '内部識別子らしき英語',
  },
  {
    code: 'wording-escape',
    re: /(判断に委ねる|スコープ外|環境担当に確認)/g,
    hint: '仕様書内で決めきってください。実施者が開発者に確認せずに完遂できること',
    label: '後始末や前提を実施者任せにする表現',
  },
  {
    code: 'wording-env-dependent',
    // 「進めなかった場合は DB にレコードは無いため削除不要」のように
    // 「場合は」と「不要／スキップ」の間に理由が挟まる書き方が多いので間隔を許容する
    re: /(場合は[^。]{0,20}(?:スキップ|不要)|投入状況に依存|0 ?件の場合)/g,
    hint: '準備手順で状態を揃えてください。環境に左右される分岐を作らない',
    label: '環境依存の場合分け',
  },
];

// 内部識別子の検出で拾ってしまうが手順書に出てよい語。
// 全大文字の略語（CSV/PDF/URL）・snake_case のファイル名・URL パスは正規表現の時点で対象外。
export const IDENTIFIER_ALLOW = ['iPhone', 'eLearning'];

// URL とファイル名は識別子・概念名の検出対象から外す（手順書に出て当然のため）
function stripNoise(text) {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.-]+\.(?:csv|tsv|pdf|xlsx?|docx?|pptx?|png|jpe?g|gif|zip)\b/gi, ' ');
}

// plan 内の全テキストを場所付きで列挙する
function collectTexts(plan) {
  const texts = [];
  (plan.groups || []).forEach((g, gi) => {
    const at = `グループ${g.no ?? gi}「${g.title ?? ''}」`;
    texts.push({ at, field: 'title', text: g.title || '' });
    (g.cases || []).forEach((c) => {
      if (c.viewpoint) texts.push({ at, field: 'viewpoint', text: c.viewpoint });
      (c.steps || []).forEach((s, si) => {
        texts.push({ at: `${at} 手順${si + 1}`, field: 'content', text: s.content || '' });
        if (s.expected) texts.push({ at: `${at} 手順${si + 1}`, field: 'expected', text: s.expected });
      });
    });
  });
  return texts;
}

export function lintPlan(plan) {
  const findings = [];
  const push = (level, code, message) => findings.push({ level, code, message });

  // 0. スキーマ（generate-requests と同じ検証。落ちたら error 1件に変換）
  try {
    validatePlan(plan);
  } catch (e) {
    push('error', 'schema', e.message);
    return findings; // 構造が壊れていたら以降のチェックは無意味
  }

  const groups = plan.groups;
  const texts = collectTexts(plan);
  const allText = texts.map((t) => t.text).join('\n');

  // 1. 手順間参照の整合: 「No.02」等がグループ内の実在手順を指すか（error）
  groups.forEach((g, gi) => {
    const stepCount = g.cases.reduce((n, c) => n + c.steps.length, 0);
    g.cases.forEach((c) => c.steps.forEach((s) => {
      for (const m of `${s.content}\n${s.expected || ''}`.matchAll(/No\.?\s*([0-9０-９]{1,2})/g)) {
        const n = parseInt(m[1].replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xFF10)), 10);
        if (n < 1 || n > stepCount) {
          push('error', 'ref-step',
            `グループ${g.no ?? gi}「${g.title}」の手順が No.${String(n).padStart(2, '0')} を参照していますが、このグループの手順は ${String(stepCount).padStart(2, '0')} までです`);
        }
      }
    }));
  });

  // 2. 定義名（「以下、「X」とする」）の未使用と後片付け漏れ（warn）
  const defs = [];
  texts.forEach(({ at, text }) => {
    for (const m of text.matchAll(/以下、?\s*(?:それぞれ)?\s*[「『]([^」』]{1,30})[」』]/g)) {
      // 「以下、それぞれ「A」「B」「C」とする」形式にも対応（直後の連続カギ括弧を拾う)
      const tail = text.slice(m.index);
      for (const name of tail.match(/[「『]([^」』]{1,30})[」』]/g)?.slice(0, 5) ?? []) {
        const clean = name.replace(/[「『」』]/g, '');
        if (!/とする|と呼ぶ/.test(clean)) defs.push({ name: clean, at, index: texts.findIndex((t) => t.at === at) });
      }
      break; // 同一テキスト内の定義は一括で拾ったので終了
    }
  });
  const lastGroup = groups[groups.length - 1];
  const lastGroupText = collectTexts({ groups: [lastGroup] }).map((t) => t.text).join('\n');
  for (const d of [...new Map(defs.map((x) => [x.name, x])).values()]) {
    const after = texts.slice(d.index + 1).map((t) => t.text).join('\n');
    if (!after.includes(d.name)) {
      push('warn', 'defined-name-unused', `「${d.name}」を定義していますが（${d.at}）、以降の手順で使われていません`);
    }
  }

  // 3. 後片付けの有無（warn）
  if (!/後片付け|クリーンアップ/.test(lastGroup.title) && !/削除/.test(lastGroupText)) {
    push('warn', 'cleanup-missing', `最後のグループ「${lastGroup.title}」に後片付け（テストデータ削除）が見当たりません`);
  }

  // 4. グループ番号の連番（warn）
  groups.forEach((g, gi) => {
    const expected = String(gi).padStart(2, '0');
    if ((g.no ?? '') !== expected) {
      push('warn', 'numbering', `グループ番号が連番でありません: ${gi + 1}番目は "${expected}" のはずが "${g.no}"`);
    }
  });

  // 5. URL 既定値（warn）
  if (!plan.siteUrl || !plan.siteUrl.startsWith('https://')) {
    push('warn', 'url-missing', 'siteUrl（検証環境URL）が未設定または https でありません');
  }
  if (!plan.prodSiteUrl) {
    push('warn', 'url-missing', 'prodSiteUrl（本番URL）が未設定です（本番確認タブに検証環境の値が残ります）');
  }

  // 6. ダミーメール規約: メールアドレスは example.com ドメインのみ（error）。
  //    実在ドメインを書くと誤送信と受信側の滞留を招く。
  for (const m of allText.matchAll(/[\w.+-]+@([\w.-]+\.[a-z]{2,})/gi)) {
    const domain = m[1].toLowerCase();
    if (domain !== 'example.com' && !domain.endsWith('.example.com')) {
      push('error', 'dummy-email', `example.com 以外のメールアドレスが使われています: ${m[0]}（QC-T3: 誤送信・滞留防止）`);
    }
  }

  // 7. 表記揺れ（warn）: 同義語の変種が2種類以上混在
  for (const variants of VARIANT_GROUPS) {
    let rest = allText;
    const used = [];
    for (const v of [...variants].sort((a, b) => b.length - a.length)) {
      if (rest.includes(v)) {
        used.push(v);
        rest = rest.split(v).join('');
      }
    }
    if (used.length >= 2) {
      push('warn', 'terminology', `表記揺れの可能性: ${used.map((u) => `「${u}」`).join(' と ')} が混在しています`);
    }
  }

  // 8. 検証のないグループ（warn）: 準備・後片付け以外で expected が1つもない
  groups.forEach((g, gi) => {
    if (gi === 0 || gi === groups.length - 1) return;
    if (/準備|後片付け/.test(g.title)) return;
    const hasExpected = g.cases.some((c) => c.steps.some((s) => s.expected));
    if (!hasExpected) {
      push('warn', 'no-expected', `グループ${g.no ?? gi}「${g.title}」に期待する結果（expected）が1つもありません（検証項目のないグループ）`);
    }
  });

  // 9. 文章規約（error）: 非エンジニアの実施者が読めない・実施者に判断を投げる表現
  texts.forEach(({ at, text }) => {
    const target = stripNoise(text);
    for (const rule of WORDING_RULES) {
      const hits = [...new Set([...target.matchAll(rule.re)].map((m) => m[0].trim()))]
        .filter((h) => !IDENTIFIER_ALLOW.includes(h));
      if (hits.length) {
        push('error', rule.code,
          `${at} に${rule.label}「${hits.join('」「')}」があります（${rule.hint}）`);
      }
    }
  });

  return findings;
}

function main() {
  const i = process.argv.indexOf('--plan');
  const planPath = i >= 0 ? process.argv[i + 1] : null;
  if (!planPath) {
    console.error('使い方: node lint-plan.mjs --plan <plan.json>');
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const findings = lintPlan(plan);
  for (const f of findings) {
    console.log(`[${f.level === 'error' ? 'ERROR' : 'WARN '}] ${f.code}: ${f.message}`);
  }
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.length - errors;
  console.error(`リント結果: ERROR ${errors} 件 / WARN ${warns} 件`);
  if (errors > 0) {
    console.error('ERROR を解消してから再実行してください（WARN は内容を確認のうえ妥当なら先へ進んでよい）');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
