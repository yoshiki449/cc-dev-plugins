#!/usr/bin/env node
// 現在のメインセッションのコンテキスト量（トークン）を JSON 1行で返す。
// 使い方: node skills/_shared/scripts/context-size.mjs [--threshold 400000]
// 出力: {"tokens":<n|null>,"threshold":<n>,"over":<bool|null>,"warning":<str|null>}
//
// 常に exit 0。判定できないときも JSON を出す（呼び出し側の set -e を殺さない）。
// 閾値と使いどころは _shared/reference/advisor-policy.md の「コンテキストの区切り」。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_THRESHOLD = 400_000;

function parseThreshold(argv) {
  const i = argv.indexOf('--threshold');
  if (i === -1) return DEFAULT_THRESHOLD;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

function findTranscript(configDir, sid) {
  const projects = path.join(configDir, 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(projects, d.name, `${sid}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function lastMainContext(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // サブエージェントの行を採ると、親が閾値を超えていても小さい値を返して区切りを促さなくなる
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const u = d.message && d.message.usage;
    if (!u) continue;
    return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return null;
}

function main() {
  const threshold = parseThreshold(process.argv.slice(2));
  const out = { tokens: null, threshold, over: null, warning: null };
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) {
    out.warning = 'CLAUDE_CODE_SESSION_ID が未設定のため判定できない';
    return out;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = findTranscript(configDir, sid);
  if (!file) {
    out.warning = `セッションのログが見つからない: ${sid}`;
    return out;
  }
  const tokens = lastMainContext(file);
  if (tokens === null) {
    out.warning = 'ログに usage を持つ応答が無い';
    return out;
  }
  out.tokens = tokens;
  out.over = tokens >= threshold;
  return out;
}

let result;
try {
  result = main();
} catch (e) {
  result = { tokens: null, threshold: DEFAULT_THRESHOLD, over: null, warning: `計測に失敗: ${e.message}` };
}
process.stdout.write(JSON.stringify(result) + '\n');
