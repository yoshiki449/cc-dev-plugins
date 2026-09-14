#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const { loadConfig } = require('./config');
const { scanVideos } = require('./scan');
const { scanHub } = require('./scanDocs');
const { readComments, writeComments, framePathFor } = require('./commentStore');
const { writeInboxEntry } = require('./feedbackInbox');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC_FILES = new Set([
  '/app.js', '/style.css', '/mdRender.js',
  '/commentCore.js', '/commentUi.js', '/iframe-agent.js',
]);

const MAX_JSON_BODY = 1024 * 1024; // 1MB（コメント）
const MAX_FRAME_BODY = 10 * 1024 * 1024; // 10MB（フレーム PNG）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const config = loadConfig();
let itemIndex = new Map();
let cachedList = [];
let cachedRuns = [];
let lastScanAt = 0;

function rescan() {
  const hub = scanHub(config);
  // 重複排除は先勝ち（enrich 済みの動画 item を、マニフェスト由来の素朴な item より優先）。
  // キーは dev:ino（bind mount で同一ファイルが複数パスから見えるケースに対応）
  const byPath = new Map();
  const byIno = new Set();
  for (const item of [...scanVideos(config), ...hub.items]) {
    if (byPath.has(item.path)) continue;
    if (item.ino) {
      if (byIno.has(item.ino)) continue;
      byIno.add(item.ino);
    }
    byPath.set(item.path, item);
  }
  const items = [...byPath.values()].sort((a, b) => b.mtime - a.mtime);
  const idx = new Map();
  for (const item of items) {
    const id = crypto.createHash('sha1').update(item.path).digest('hex').slice(0, 16);
    item.id = id;
    idx.set(id, item);
    // サイドカーがあればコメント件数を載せる（一覧の 💬 バッジ用）
    item.comments = fs.existsSync(`${item.path}.comments.json`)
      ? readComments(item.path).comments.length
      : 0;
  }
  itemIndex = idx;
  cachedList = items;
  const inoToItem = new Map();
  for (const item of items) {
    if (item.ino && !inoToItem.has(item.ino)) inoToItem.set(item.ino, item);
  }
  const resolveArtifact = (p) => {
    if (byPath.has(p)) return byPath.get(p).id;
    // 別マウントパス経由で dedupe された場合は ino で引き直す
    try {
      const st = fs.statSync(p);
      const hit = inoToItem.get(`${st.dev}:${st.ino}`);
      if (hit) return hit.id;
    } catch (_err) {}
    return null;
  };
  cachedRuns = hub.runs.map((r) => ({
    key: crypto.createHash('sha1').update(r.manifestPath).digest('hex').slice(0, 16),
    runId: r.runId,
    label: r.label,
    flow: r.flow,
    issue: r.issue,
    project: r.project,
    worktree: r.worktree,
    mtime: r.mtime,
    itemIds: r.artifactPaths.map(resolveArtifact).filter(Boolean),
  }));
  lastScanAt = Date.now();
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
}

function streamVideo(req, res, video) {
  let stat;
  try {
    stat = fs.statSync(video.path);
  } catch (_err) {
    res.writeHead(404);
    res.end('File missing');
    return;
  }
  const total = stat.size;
  const range = req.headers.range;
  const ext = path.extname(video.path).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    if (start > end || end >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(video.path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Length': total,
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(video.path).pipe(res);
}

// explanation HTML の </body> 直前にコメント用エージェントを注入する（mce の方式）。
// </body> が無い HTML は末尾に付加する
function injectAgentScript(html) {
  const tag = '<script src="/iframe-agent.js"></script>';
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + tag;
  return html.slice(0, idx) + tag + html.slice(idx);
}

// リクエストボディをサイズ上限付きで読む
function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  req.on('data', (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > limit) {
      done = true;
      cb(new Error(`body too large (max ${limit} bytes)`));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    cb(null, Buffer.concat(chunks));
  });
  req.on('error', (err) => {
    if (done) return;
    done = true;
    cb(err);
  });
}

function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
    sendStatic(res, path.join(PUBLIC_DIR, pathname.slice(1)));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/items') {
    sendJson(res, 200, {
      scannedAt: lastScanAt,
      scanRoots: config.scanRoots,
      inDocker: config.inDocker,
      allowDelete: config.allowDelete,
      runs: cachedRuns,
      items: cachedList.map((v) => ({
        id: v.id,
        type: v.type,
        title: v.title,
        comments: v.comments,
        name: v.name,
        project: v.project,
        worktree: v.worktree,
        category: v.category,
        scenarioNumber: v.scenarioNumber,
        test: v.test,
        dirName: v.dirName,
        specFile: v.specFile,
        specLine: v.specLine,
        describe: v.describe,
        browser: v.browser,
        retry: v.retry,
        outcome: v.outcome,
        matched: v.matched,
        path: v.path,
        size: v.size,
        mtime: v.mtime,
        writable: v.writable,
      })),
    });
    return;
  }

  // md / HTML 成果物の配信。id ホワイトリスト方式（/video と同じ）。
  // md は text/plain で返しフロント側でエスケープ後レンダリング（XSS 防止）。
  // explanation は </body> 直前にコメント用エージェントスクリプトを注入して配信する。
  if (req.method === 'GET' && pathname === '/doc') {
    const id = parsed.query.id;
    const item = id && itemIndex.get(String(id));
    if (!item || item.type === 'video') {
      res.writeHead(404);
      res.end('Unknown doc id');
      return;
    }
    fs.readFile(item.path, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('File missing');
        return;
      }
      let body = data;
      let contentType = 'text/plain; charset=utf-8';
      if (item.type === 'explanation') {
        contentType = 'text/html; charset=utf-8';
        body = Buffer.from(injectAgentScript(data.toString('utf8')), 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    return;
  }

  // コメント（サイドカー <対象>.comments.json、write-through）
  if (pathname === '/api/comments') {
    const id = parsed.query.id;
    const item = id && itemIndex.get(String(id));
    if (!item) {
      sendJson(res, 404, { error: 'unknown id' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, readComments(item.path));
      return;
    }
    if (req.method === 'PUT') {
      readBody(req, MAX_JSON_BODY, (err, buf) => {
        if (err) {
          sendJson(res, 413, { error: err.message });
          return;
        }
        try {
          const data = JSON.parse(buf.toString('utf8'));
          const saved = writeComments(item.path, data.comments);
          sendJson(res, 200, saved);
        } catch (e) {
          const status = /must|too many/.test(String(e.message)) ? 400 : 500;
          sendJson(res, status, { error: String(e.message) });
        }
      });
      return;
    }
    res.writeHead(405);
    res.end();
    return;
  }

  // 動画フレームのスクリーンショット保存（PNG、<動画>.frame-<ms>.png）
  if (req.method === 'POST' && pathname === '/api/frame') {
    const id = parsed.query.id;
    const item = id && itemIndex.get(String(id));
    const rawT = String(parsed.query.t ?? '');
    const t = /^\d+$/.test(rawT) ? Number.parseInt(rawT, 10) : NaN;
    if (!item || item.type !== 'video') {
      sendJson(res, 404, { error: 'unknown video id' });
      return;
    }
    if (!Number.isInteger(t)) {
      sendJson(res, 400, { error: 't (ms) must be a non-negative integer' });
      return;
    }
    readBody(req, MAX_FRAME_BODY, (err, buf) => {
      if (err) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      // PNG マジックナンバー検査（\x89PNG）
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
        sendJson(res, 400, { error: 'body must be a PNG' });
        return;
      }
      try {
        const framePath = framePathFor(item.path, t);
        fs.writeFileSync(framePath, buf);
        sendJson(res, 200, { ok: true, path: framePath, t });
      } catch (e) {
        sendJson(res, 500, { error: String(e.message) });
      }
    });
    return;
  }

  // コメントを対象プロジェクトの .agent/feedback-inbox/ へ書き出し（/auto-feedback --inbox 用）。
  // body なし: 内容はサーバ管理のサイドカーから読む（クライアントは id しか指定できない）
  if (req.method === 'POST' && pathname === '/api/feedback-inbox') {
    const id = parsed.query.id;
    const item = id && itemIndex.get(String(id));
    if (!item) {
      sendJson(res, 404, { error: 'unknown id' });
      return;
    }
    try {
      const { comments } = readComments(item.path);
      if (comments.length === 0) {
        sendJson(res, 400, { error: 'no comments' });
        return;
      }
      const { path: dest, count } = writeInboxEntry(item, comments);
      sendJson(res, 200, { ok: true, path: dest, count });
    } catch (e) {
      const status = /root not found/.test(String(e.message)) ? 400 : 500;
      sendJson(res, status, { error: String(e.message) });
    }
    return;
  }

  // 保存済みフレーム画像の配信（パスは item.path + 整数 t から導出 = ホワイトリスト）
  if (req.method === 'GET' && pathname === '/frame') {
    const id = parsed.query.id;
    const item = id && itemIndex.get(String(id));
    const rawT = String(parsed.query.t ?? '');
    const t = /^\d+$/.test(rawT) ? Number.parseInt(rawT, 10) : NaN;
    if (!item || item.type !== 'video' || !Number.isInteger(t)) {
      res.writeHead(404);
      res.end();
      return;
    }
    fs.readFile(framePathFor(item.path, t), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/rescan') {
    rescan();
    sendJson(res, 200, { ok: true, count: cachedList.length });
    return;
  }

  if (req.method === 'GET' && pathname === '/video') {
    const id = parsed.query.id;
    const video = id && itemIndex.get(String(id));
    if (!video || video.type !== 'video') {
      res.writeHead(404);
      res.end('Unknown video id');
      return;
    }
    streamVideo(req, res, video);
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/video') {
    if (!config.allowDelete) {
      sendJson(res, 403, { error: 'delete disabled (set ALLOW_DELETE=1 to enable)' });
      return;
    }
    const id = parsed.query.id;
    const video = id && itemIndex.get(String(id));
    if (!video) {
      sendJson(res, 404, { error: 'unknown id' });
      return;
    }
    if (video.type !== 'video') {
      sendJson(res, 403, { error: 'delete is only allowed for videos' });
      return;
    }
    if (!video.writable) {
      sendJson(res, 403, { error: 'file is on a read-only mount' });
      return;
    }
    try {
      fs.unlinkSync(video.path);
      itemIndex.delete(video.id);
      cachedList = cachedList.filter((v) => v.id !== video.id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err && err.message) });
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

function main() {
  process.stdout.write(`[dev-hub] scanning ${config.scanRoots.join(', ')} ...\n`);
  const t0 = Date.now();
  rescan();
  const counts = {};
  for (const item of cachedList) counts[item.type] = (counts[item.type] || 0) + 1;
  const countsStr = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
  process.stdout.write(
    `[dev-hub] found ${cachedList.length} items (${countsStr}) in ${Date.now() - t0}ms\n`,
  );

  const server = http.createServer(handle);
  server.listen(config.port, config.host, () => {
    process.stdout.write(`[dev-hub] listening on http://${config.host}:${config.port}\n`);
    if (config.inDocker && config.host === '0.0.0.0') {
      process.stdout.write(
        `[dev-hub] running inside Docker — open http://localhost:${config.port} from your host browser (requires port ${config.port} to be published)\n` +
        `[dev-hub] 複数コンテナ並行時はホスト側ポートがオフセットされます（例: 7779->7777）。` +
        `ホストで docker ps --format '{{.ID}}\\t{{.Ports}}' を実行し、このコンテナの ${config.port} がホストのどのポートに割当てられているか確認してください\n`,
      );
    }
    if (!config.allowDelete) {
      process.stdout.write('[dev-hub] delete endpoint disabled (set ALLOW_DELETE=1 to enable)\n');
    }
    process.stdout.write('[dev-hub] press Ctrl+C to stop\n');
  });

  process.on('SIGINT', () => {
    process.stdout.write('\n[dev-hub] shutting down\n');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) main();
