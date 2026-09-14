'use strict';

const fs = require('fs');
const path = require('path');

const jsonReportCache = new Map();

function findJsonReport(videoPath) {
  let dir = path.dirname(videoPath);
  for (let i = 0; i < 10; i += 1) {
    const candidates = [
      path.join(dir, 'results.json'),
      path.join(dir, 'test-results.json'),
      path.join(dir, 'playwright-results.json'),
      path.join(dir, 'test-results', 'results.json'),
    ];
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch (_err) {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function mapOutcome(status) {
  if (status === 'passed') return 'expected';
  if (status === 'failed' || status === 'timedOut' || status === 'interrupted') return 'unexpected';
  if (status === 'flaky') return 'flaky';
  if (status === 'skipped') return 'skipped';
  return status;
}

function buildVideoMap(report) {
  const map = new Map();

  function processTest(test, spec, suiteTitles) {
    for (const r of test.results || []) {
      for (const a of r.attachments || []) {
        if (a.name !== 'video' || !a.path) continue;
        const abs = path.resolve(a.path);
        map.set(abs, {
          title: spec.title,
          describe: suiteTitles.filter((t) => !!t && !/\.spec\.[tj]sx?$/.test(t)),
          file: spec.file || (spec.location && spec.location.file),
          line: spec.line || (spec.location && spec.location.line),
          browser: test.projectName,
          outcome: mapOutcome(test.status || r.status),
        });
      }
    }
  }

  function walkSuite(suite, parentTitles) {
    const titles = [...parentTitles];
    if (suite.title) titles.push(suite.title);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        processTest(t, spec, titles);
      }
    }
    for (const sub of suite.suites || []) walkSuite(sub, titles);
  }

  for (const s of report.suites || []) walkSuite(s, []);
  return map;
}

function getReport(jsonPath) {
  if (jsonReportCache.has(jsonPath)) return jsonReportCache.get(jsonPath);
  let videoMap = null;
  try {
    const text = fs.readFileSync(jsonPath, 'utf8');
    const report = JSON.parse(text);
    videoMap = buildVideoMap(report);
  } catch (_err) {
    videoMap = null;
  }
  jsonReportCache.set(jsonPath, videoMap);
  return videoMap;
}

function lookup(videoPath) {
  const jsonPath = findJsonReport(videoPath);
  if (!jsonPath) return null;
  const map = getReport(jsonPath);
  if (!map) return null;
  return map.get(path.resolve(videoPath)) || null;
}

function resetCache() {
  jsonReportCache.clear();
}

module.exports = { lookup, resetCache, findJsonReport };
