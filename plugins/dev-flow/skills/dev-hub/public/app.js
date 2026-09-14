'use strict';

const state = {
  items: [],
  runs: [],
  view: 'runs', // 'runs' | 'inbox' | 'project'
  filterProject: null,
  filterType: 'all', // 'all' | 'video' | 'doc' | 'plan' | 'explanation'
  filterText: '',
  currentRate: 0.25,
  currentVideoId: null,
  currentDocId: null,
  allowDelete: false,
  expandedGroups: new Set(),
  runToggles: new Map(), // run key → open 状態（未操作は既定値: 先頭のみ open）
  loop: true,
};

const WORKTREE_NONE = '__main__';

const TYPE_ORDER = ['doc', 'plan', 'ledger', 'report', 'explanation', 'video'];
const TYPE_META = {
  video: { icon: '🎬', label: '動画' },
  doc: { icon: '📄', label: 'ドキュメント' },
  plan: { icon: '📋', label: 'プラン' },
  ledger: { icon: '🧪', label: 'テスト台帳' },
  report: { icon: '🧾', label: 'レポート' },
  explanation: { icon: '💡', label: '説明' },
};

function groupKey(project, worktree) {
  return `${project}${worktree || WORKTREE_NONE}`;
}

const els = {
  list: document.getElementById('list'),
  projects: document.getElementById('projects'),
  search: document.getElementById('search'),
  typeFilters: document.getElementById('type-filters'),
  rescan: document.getElementById('rescan'),
  expandAll: document.getElementById('expand-all'),
  collapseAll: document.getElementById('collapse-all'),
  status: document.getElementById('status'),
  playerOverlay: document.getElementById('player-overlay'),
  playerPane: document.getElementById('player-pane'),
  player: document.getElementById('player'),
  playerTitle: document.getElementById('player-title'),
  playerMeta: document.getElementById('player-meta'),
  playerPath: document.getElementById('player-path'),
  playerClose: document.getElementById('player-close'),
  playerMaximize: document.getElementById('player-maximize'),
  playerPrev: document.getElementById('player-prev'),
  playerNext: document.getElementById('player-next'),
  playerPosition: document.getElementById('player-position'),
  playerDelete: document.getElementById('player-delete'),
  playerLoop: document.getElementById('player-loop'),
  speedButtons: document.getElementById('speed-buttons'),
  docOverlay: document.getElementById('doc-overlay'),
  docTitle: document.getElementById('doc-title'),
  docMeta: document.getElementById('doc-meta'),
  docPath: document.getElementById('doc-path'),
  docClose: document.getElementById('doc-close'),
  docMaximize: document.getElementById('doc-maximize'),
  docFrame: document.getElementById('doc-frame'),
  mdBody: document.getElementById('md-body'),
  commentCount: document.getElementById('comment-count'),
  commentPanel: document.getElementById('comment-panel'),
  copyJson: document.getElementById('copy-json'),
  copyPrompt: document.getElementById('copy-prompt'),
  sendInbox: document.getElementById('send-inbox'),
  popover: document.getElementById('comment-popover'),
  popoverLabel: document.getElementById('comment-popover-label'),
  popoverText: document.getElementById('comment-popover-text'),
  popoverSave: document.getElementById('comment-popover-save'),
  popoverCancel: document.getElementById('comment-popover-cancel'),
  frameComment: document.getElementById('frame-comment'),
  videoCopyPrompt: document.getElementById('video-copy-prompt'),
  videoSendInbox: document.getElementById('video-send-inbox'),
  videoCommentPane: document.getElementById('video-comment-pane'),
  videoCommentPanel: document.getElementById('video-comment-panel'),
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadItems() {
  els.status.textContent = '読み込み中...';
  const res = await fetch('/api/items');
  const data = await res.json();
  state.items = data.items;
  state.runs = data.runs || [];
  state.allowDelete = !!data.allowDelete;
  if (state.view === 'runs' && state.runs.length === 0) state.view = 'inbox';
  const envLabel = data.inDocker ? '（Docker 内）' : '';
  els.status.textContent = `${data.items.length} 件 / 最終スキャン: ${formatDate(data.scannedAt)} ${envLabel}`;
  renderSidebar();
  render();
}

async function rescan() {
  els.status.textContent = '再スキャン中...';
  els.rescan.disabled = true;
  try {
    await fetch('/api/rescan', { method: 'POST' });
    await loadItems();
  } finally {
    els.rescan.disabled = false;
  }
}

// プロジェクト絞り込み＋テキスト検索まで適用（種類フィルタは適用しない）
function getScoped() {
  let items = state.items;
  if (state.view === 'project' && state.filterProject) {
    items = items.filter((v) => v.project === state.filterProject);
  }
  const q = state.filterText.trim().toLowerCase();
  if (q) {
    items = items.filter((v) =>
      (v.project + ' ' + (v.worktree || '') + ' ' + (v.title || '') + ' ' + (v.test || '') + ' ' + v.name + ' ' + v.path)
        .toLowerCase()
        .includes(q),
    );
  }
  return items;
}

function getFiltered() {
  let items = getScoped();
  if (state.filterType !== 'all') {
    items = items.filter((v) => v.type === state.filterType);
  }
  return items;
}

const CATEGORY_ORDER = ['user-stories', 'functional', 'other'];
const CATEGORY_LABEL = {
  'user-stories': 'ユーザーストーリーテスト',
  functional: '機能テスト',
  other: 'その他',
};

function sortVideosInCategory(category, videos) {
  if (category === 'user-stories') {
    return videos.slice().sort((a, b) => {
      const an = a.scenarioNumber == null ? Number.POSITIVE_INFINITY : a.scenarioNumber;
      const bn = b.scenarioNumber == null ? Number.POSITIVE_INFINITY : b.scenarioNumber;
      if (an !== bn) return an - bn;
      return (a.test || '').localeCompare(b.test || '', 'ja');
    });
  }
  return videos.slice().sort((a, b) => b.mtime - a.mtime);
}

function groupVideos(videos) {
  const projects = new Map();
  for (const v of videos) {
    if (!projects.has(v.project)) projects.set(v.project, new Map());
    const worktrees = projects.get(v.project);
    const wt = v.worktree || WORKTREE_NONE;
    if (!worktrees.has(wt)) worktrees.set(wt, new Map());
    const cats = worktrees.get(wt);
    const cat = v.category || 'other';
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push(v);
  }
  const result = [];
  for (const [project, worktrees] of projects) {
    const wts = [];
    let projectTotal = 0;
    let projectLatest = 0;
    for (const [wt, cats] of worktrees) {
      const catList = [];
      let wtTotal = 0;
      let wtLatest = 0;
      for (const catName of CATEGORY_ORDER) {
        if (!cats.has(catName)) continue;
        const list = sortVideosInCategory(catName, cats.get(catName));
        const latest = list.reduce((acc, v) => Math.max(acc, v.mtime), 0);
        catList.push({ name: catName, videos: list, latest });
        wtTotal += list.length;
        if (latest > wtLatest) wtLatest = latest;
      }
      projectTotal += wtTotal;
      if (wtLatest > projectLatest) projectLatest = wtLatest;
      wts.push({ name: wt, categories: catList, total: wtTotal, latest: wtLatest });
    }
    wts.sort((a, b) => b.latest - a.latest);
    result.push({ project, worktrees: wts, total: projectTotal, latest: projectLatest });
  }
  result.sort((a, b) => b.latest - a.latest);
  return result;
}

function makeEl(tag, opts = {}, children = []) {
  const el = document.createElement(tag);
  if (opts.className) el.className = opts.className;
  if (opts.text != null) el.textContent = opts.text;
  for (const child of children) {
    if (child) el.appendChild(child);
  }
  return el;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makeSidebarItem(label, count, isActive, onClick) {
  const li = makeEl('li', {}, [
    makeEl('span', { text: label }),
    makeEl('span', { className: 'count', text: String(count) }),
  ]);
  if (isActive) li.classList.add('active');
  li.addEventListener('click', onClick);
  return li;
}

function renderSidebar() {
  const counts = new Map();
  for (const v of state.items) {
    counts.set(v.project, (counts.get(v.project) || 0) + 1);
  }
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  clearChildren(els.projects);

  if (state.runs.length > 0) {
    els.projects.appendChild(
      makeSidebarItem('🏃 実行履歴', state.runs.length, state.view === 'runs', () => {
        state.view = 'runs';
        state.filterProject = null;
        renderSidebar();
        render();
      }),
    );
  }

  els.projects.appendChild(
    makeSidebarItem('📥 インボックス', state.items.length, state.view === 'inbox', () => {
      state.view = 'inbox';
      state.filterProject = null;
      renderSidebar();
      render();
    }),
  );

  for (const [project, count] of items) {
    els.projects.appendChild(
      makeSidebarItem(
        project,
        count,
        state.view === 'project' && state.filterProject === project,
        () => {
          state.view = 'project';
          state.filterProject = project;
          renderSidebar();
          render();
        },
      ),
    );
  }
}

function renderTypeFilters() {
  const scoped = getScoped();
  const counts = { all: scoped.length };
  for (const t of TYPE_ORDER) counts[t] = 0;
  for (const v of scoped) counts[v.type] = (counts[v.type] || 0) + 1;

  clearChildren(els.typeFilters);
  const defs = [['all', { icon: '', label: 'すべて' }], ...TYPE_ORDER.map((t) => [t, TYPE_META[t]])];
  for (const [type, meta] of defs) {
    if (type !== 'all' && counts[type] === 0) continue;
    const label = `${meta.icon ? meta.icon + ' ' : ''}${meta.label} ${counts[type]}`;
    const btn = makeEl('button', { className: 'type-chip', text: label });
    btn.type = 'button';
    if (state.filterType === type) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.filterType = state.filterType === type ? 'all' : type;
      render();
    });
    els.typeFilters.appendChild(btn);
  }
}

function outcomeMark(outcome) {
  if (outcome === 'expected') return { text: '✓', className: 'mark-pass' };
  if (outcome === 'unexpected') return { text: '✗', className: 'mark-fail' };
  if (outcome === 'flaky') return { text: '⚠', className: 'mark-flaky' };
  if (outcome === 'skipped') return { text: '○', className: 'mark-skip' };
  return null;
}

function openItem(item) {
  if (item.type === 'video') playVideo(item);
  else openDoc(item);
}

// インボックス／ドキュメントセクション共通の行
function makeItemRow(v, { showProject }) {
  const meta = TYPE_META[v.type] || { icon: '❓' };
  const titleNodes = [makeEl('span', { className: 'type-icon', text: meta.icon })];
  if (v.type === 'video') {
    const mark = outcomeMark(v.outcome);
    if (mark) titleNodes.push(makeEl('span', { className: `outcome ${mark.className}`, text: mark.text }));
  }
  titleNodes.push(makeEl('span', { className: 'video-row-title-text', text: v.title || v.name }));

  const metaNodes = [];
  if (v.comments > 0) metaNodes.push(makeEl('span', { className: 'tag tag-comments', text: `💬 ${v.comments}` }));
  if (showProject) metaNodes.push(makeEl('span', { className: 'tag tag-project', text: v.project }));
  if (v.worktree) metaNodes.push(makeEl('span', { className: 'tag', text: v.worktree }));
  metaNodes.push(makeEl('span', { text: formatDate(v.mtime) }));
  metaNodes.push(makeEl('span', { text: formatSize(v.size) }));

  const row = makeEl('div', { className: 'video-row' }, [
    makeEl('div', { className: 'video-row-main' }, [
      makeEl('div', { className: 'video-row-test' }, titleNodes),
      makeEl('div', { className: 'video-row-meta' }, metaNodes),
    ]),
  ]);
  if (v.id === state.currentVideoId || v.id === state.currentDocId) row.classList.add('active');
  row.addEventListener('click', () => openItem(v));
  return row;
}

// 動画専用行（既存 UI: outcome・spec 位置・ブラウザ等のメタ付き）
function makeVideoRow(v) {
  const titleNodes = [];
  const mark = outcomeMark(v.outcome);
  if (mark) titleNodes.push(makeEl('span', { className: `outcome ${mark.className}`, text: mark.text }));
  titleNodes.push(makeEl('span', { className: 'video-row-title-text', text: v.test }));

  const metaNodes = [];
  if (v.comments > 0) metaNodes.push(makeEl('span', { className: 'tag tag-comments', text: `💬 ${v.comments}` }));
  if (v.specFile) {
    const loc = v.specLine ? `${v.specFile}:${v.specLine}` : v.specFile;
    metaNodes.push(makeEl('span', { className: 'spec-loc', text: loc }));
  }
  if (v.browser) metaNodes.push(makeEl('span', { className: 'tag tag-browser', text: v.browser }));
  if (v.retry) metaNodes.push(makeEl('span', { className: 'tag tag-retry', text: `retry ${v.retry}` }));
  metaNodes.push(makeEl('span', { text: formatDate(v.mtime) }));
  metaNodes.push(makeEl('span', { text: formatSize(v.size) }));
  if (!v.writable) metaNodes.push(makeEl('span', { className: 'tag', text: 'RO' }));
  if (!v.matched) metaNodes.push(makeEl('span', { className: 'tag tag-warn', text: 'タイトル推定' }));

  const row = makeEl('div', { className: 'video-row' }, [
    makeEl('div', { className: 'video-row-main' }, [
      makeEl('div', { className: 'video-row-test' }, titleNodes),
      makeEl('div', { className: 'video-row-meta' }, metaNodes),
    ]),
  ]);
  if (v.id === state.currentVideoId) row.classList.add('active');
  row.addEventListener('click', () => playVideo(v));
  return row;
}

function makeGroup(project, worktreeName, categories, total, latest, isOpen, onToggle) {
  const summary = makeEl('summary', { className: 'group-summary' }, [
    makeEl('span', { className: 'group-caret', text: '▸' }),
    makeEl('span', { className: 'group-title', text: worktreeName }),
    makeEl('span', { className: 'group-count', text: `${total} 件` }),
    makeEl('span', { className: 'group-latest', text: formatDate(latest) }),
  ]);
  const body = makeEl('div', { className: 'group-body' });
  for (const cat of categories) {
    const label = CATEGORY_LABEL[cat.name] || cat.name;
    body.appendChild(
      makeEl('div', { className: `category-header category-${cat.name}` }, [
        makeEl('span', { className: 'category-label', text: label }),
        makeEl('span', { className: 'category-count', text: `${cat.videos.length} 件` }),
      ]),
    );
    for (const v of cat.videos) body.appendChild(makeVideoRow(v));
  }
  const details = makeEl('details', { className: 'group' }, [summary, body]);
  if (isOpen) details.open = true;
  details.addEventListener('toggle', () => onToggle(details.open));
  return details;
}

function render() {
  renderTypeFilters();
  clearChildren(els.list);
  const filtered = getFiltered();
  if (state.view === 'runs') {
    renderRuns(filtered);
    return;
  }
  if (filtered.length === 0) {
    els.list.appendChild(makeEl('div', { className: 'empty', text: '該当する成果物はありません' }));
    return;
  }
  if (state.view === 'inbox') renderInbox(filtered);
  else renderProject(filtered);
}

// 実行グループ（<details>）を描画する共通処理
function renderRunGroups(runs, visibleIds, itemById, { showProject }) {
  const isSearching = state.filterText.trim().length > 0;
  let rendered = 0;
  runs.forEach((run, index) => {
    const items = run.itemIds
      .map((id) => itemById.get(id))
      .filter((it) => it && visibleIds.has(it.id))
      .sort((a, b) => a.mtime - b.mtime); // 実行内は時系列（プラン → 設計 → 動画）
    if (items.length === 0) return;

    const key = `run:${run.key}`;
    const summaryNodes = [
      makeEl('span', { className: 'group-caret', text: '▸' }),
      makeEl('span', { className: 'group-title', text: `🏃 ${run.label}` }),
    ];
    if (run.issue != null) summaryNodes.push(makeEl('span', { className: 'tag tag-browser', text: `#${run.issue}` }));
    if (run.flow) summaryNodes.push(makeEl('span', { className: 'tag', text: run.flow }));
    if (showProject) summaryNodes.push(makeEl('span', { className: 'tag tag-project', text: run.project }));
    if (run.worktree) summaryNodes.push(makeEl('span', { className: 'tag', text: run.worktree }));
    summaryNodes.push(makeEl('span', { className: 'group-count', text: `${items.length} 件` }));
    summaryNodes.push(makeEl('span', { className: 'group-latest', text: formatDate(run.mtime) }));

    const summary = makeEl('summary', { className: 'group-summary' }, summaryNodes);
    const body = makeEl('div', { className: 'group-body' });
    for (const it of items) body.appendChild(makeItemRow(it, { showProject: false }));

    const details = makeEl('details', { className: 'group' }, [summary, body]);
    const isOpen = state.runToggles.has(key)
      ? state.runToggles.get(key)
      : isSearching || index === 0; // 未操作なら最新の実行だけ開く
    if (isOpen) details.open = true;
    details.addEventListener('toggle', () => state.runToggles.set(key, details.open));
    els.list.appendChild(details);
    rendered += 1;
  });
  return rendered;
}

// 実行履歴ビュー: 全プロジェクトの実行を新しい順に
function renderRuns(filteredItems) {
  const itemById = new Map(state.items.map((i) => [i.id, i]));
  const visibleIds = new Set(filteredItems.map((i) => i.id));
  const q = state.filterText.trim().toLowerCase();
  const runs = state.runs.filter((r) => {
    if (!q) return true;
    if ((r.label + ' ' + r.project + ' ' + (r.flow || '')).toLowerCase().includes(q)) return true;
    return r.itemIds.some((id) => visibleIds.has(id));
  });
  const rendered = renderRunGroups(runs, visibleIds, itemById, { showProject: true });
  if (rendered === 0) {
    els.list.appendChild(
      makeEl('div', {
        className: 'empty',
        text: '該当する実行がありません。実行マニフェスト（.agent/hub-runs/）は dev-plan / auto-build / dev-ship 等の実行時に自動生成されます',
      }),
    );
  }
}

// 種類横断・mtime 降順のフラットリスト
function renderInbox(items) {
  const sorted = items.slice().sort((a, b) => b.mtime - a.mtime);
  for (const v of sorted) {
    els.list.appendChild(makeItemRow(v, { showProject: true }));
  }
}

// 1プロジェクトの成果物を種類セクション順に表示（動画は既存グルーピングを温存）
function renderProject(items) {
  // 冒頭にこのプロジェクトの実行履歴セクション
  const projectRuns = state.runs.filter((r) => r.project === state.filterProject);
  if (projectRuns.length > 0) {
    els.list.appendChild(
      makeEl('div', { className: 'project-header' }, [
        makeEl('span', { className: 'project-name', text: '🏃 実行履歴' }),
        makeEl('span', { className: 'project-count', text: `${projectRuns.length} 件` }),
      ]),
    );
    const itemById = new Map(state.items.map((i) => [i.id, i]));
    const visibleIds = new Set(items.map((i) => i.id));
    renderRunGroups(projectRuns, visibleIds, itemById, { showProject: false });
  }

  for (const type of TYPE_ORDER) {
    const ofType = items.filter((v) => v.type === type);
    if (ofType.length === 0) continue;
    const meta = TYPE_META[type];

    els.list.appendChild(
      makeEl('div', { className: 'project-header' }, [
        makeEl('span', { className: 'project-name', text: `${meta.icon} ${meta.label}` }),
        makeEl('span', { className: 'project-count', text: `${ofType.length} 件` }),
      ]),
    );

    if (type !== 'video') {
      const sorted = ofType.slice().sort((a, b) => b.mtime - a.mtime);
      for (const v of sorted) {
        els.list.appendChild(makeItemRow(v, { showProject: false }));
      }
      continue;
    }

    const isSearching = state.filterText.trim().length > 0;
    for (const g of groupVideos(ofType)) {
      for (const wt of g.worktrees) {
        const displayName = wt.name === WORKTREE_NONE ? '(メインツリー)' : wt.name;
        const key = groupKey(g.project, wt.name);
        const isOpen = isSearching || state.expandedGroups.has(key);
        els.list.appendChild(
          makeGroup(g.project, displayName, wt.categories, wt.total, wt.latest, isOpen, (open) => {
            if (open) state.expandedGroups.add(key);
            else state.expandedGroups.delete(key);
          }),
        );
      }
    }
  }
}

function expandAll() {
  state.expandedGroups.clear();
  for (const v of state.items) {
    if (v.type !== 'video') continue;
    state.expandedGroups.add(groupKey(v.project, v.worktree || WORKTREE_NONE));
  }
  for (const r of state.runs) state.runToggles.set(`run:${r.key}`, true);
  render();
}

function collapseAll() {
  state.expandedGroups.clear();
  for (const r of state.runs) state.runToggles.set(`run:${r.key}`, false);
  render();
}

// プレイヤーの前後ナビ用: 表示中スコープの動画をグルーピング順にフラット化
function getOrderedVideos() {
  const videos = getFiltered().filter((v) => v.type === 'video');
  if (state.view === 'inbox') {
    return videos.slice().sort((a, b) => b.mtime - a.mtime);
  }
  const ordered = [];
  for (const g of groupVideos(videos)) {
    for (const wt of g.worktrees) {
      for (const cat of wt.categories) {
        ordered.push(...cat.videos);
      }
    }
  }
  return ordered;
}

function updatePlayerNav() {
  const ordered = getOrderedVideos();
  const idx = ordered.findIndex((v) => v.id === state.currentVideoId);
  els.playerPrev.disabled = idx <= 0;
  els.playerNext.disabled = idx < 0 || idx >= ordered.length - 1;
  els.playerPosition.textContent = idx >= 0 ? `${idx + 1} / ${ordered.length}` : '';
}

function playAdjacent(offset) {
  const ordered = getOrderedVideos();
  const idx = ordered.findIndex((v) => v.id === state.currentVideoId);
  if (idx < 0) return;
  const next = ordered[idx + offset];
  if (next) playVideo(next);
}

function applyRate() {
  els.player.defaultPlaybackRate = state.currentRate;
  if (Math.abs(els.player.playbackRate - state.currentRate) > 0.001) {
    els.player.playbackRate = state.currentRate;
  }
}

function playVideo(v) {
  state.currentVideoId = v.id;
  els.player.loop = state.loop;
  els.player.defaultPlaybackRate = state.currentRate;
  els.player.src = `/video?id=${encodeURIComponent(v.id)}`;
  applyRate();
  els.player.play().then(applyRate).catch(() => {});
  els.playerTitle.textContent = v.test;
  const metaParts = [v.project];
  if (v.worktree) metaParts.push(`worktree: ${v.worktree}`);
  if (v.browser) metaParts.push(v.browser);
  if (v.specFile) metaParts.push(v.specLine ? `${v.specFile}:${v.specLine}` : v.specFile);
  metaParts.push(formatDate(v.mtime));
  metaParts.push(formatSize(v.size));
  if (!v.writable) metaParts.push('読み取り専用');
  els.playerMeta.textContent = metaParts.join(' ・ ');
  els.playerPath.textContent = v.path;
  const canDelete = state.allowDelete && v.writable;
  els.playerDelete.style.display = canDelete ? '' : 'none';
  els.playerOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  updatePlayerNav();
  render();
  loadVideoComments(v);
}

function closePlayer() {
  els.player.pause();
  els.player.removeAttribute('src');
  els.player.load();
  state.currentVideoId = null;
  hideCommentPopover();
  resetCommentState();
  els.videoCommentPane.classList.add('hidden');
  els.playerOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  render();
}

// md / HTML 成果物のビューア
async function openDoc(v) {
  state.currentDocId = v.id;
  els.docTitle.textContent = v.title || v.name;
  const metaParts = [`${TYPE_META[v.type].icon} ${TYPE_META[v.type].label}`, v.project];
  if (v.worktree) metaParts.push(`worktree: ${v.worktree}`);
  metaParts.push(formatDate(v.mtime));
  metaParts.push(formatSize(v.size));
  els.docMeta.textContent = metaParts.join(' ・ ');
  els.docPath.textContent = v.path;
  els.docOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  resetCommentState();
  commentState.item = v;

  if (v.type === 'explanation') {
    els.mdBody.classList.add('hidden');
    els.docFrame.classList.remove('hidden');
    // iframe とのコメント連携（選択→ポップオーバー、ハイライト再送）
    commentState.bridge = createIframeBridge(els.docFrame, { onSelection: onIframeSelection });
    els.docFrame.onload = () => restoreDocHighlights();
    els.docFrame.src = `/doc?id=${encodeURIComponent(v.id)}`;
  } else {
    els.docFrame.classList.add('hidden');
    els.docFrame.removeAttribute('src');
    els.mdBody.classList.remove('hidden');
    els.mdBody.innerHTML = '';
    try {
      const res = await fetch(`/doc?id=${encodeURIComponent(v.id)}`);
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      commentState.sourceText = text;
      els.mdBody.innerHTML = renderMarkdown(text);
    } catch (_err) {
      els.mdBody.textContent = '読み込みに失敗しました';
    }
  }
  commentState.comments = await fetchComments(v);
  renderDocCommentPanel();
  restoreDocHighlights();
  render();
}

function closeDoc() {
  state.currentDocId = null;
  hideCommentPopover();
  resetCommentState();
  els.docFrame.onload = null;
  els.docFrame.removeAttribute('src');
  els.mdBody.innerHTML = '';
  els.docOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  render();
}

async function deleteCurrentVideo() {
  if (!state.currentVideoId) return;
  if (!confirm('この動画ファイルを物理削除します。よろしいですか？')) return;
  const res = await fetch(`/api/video?id=${encodeURIComponent(state.currentVideoId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    alert('削除に失敗しました');
    return;
  }
  state.items = state.items.filter((v) => v.id !== state.currentVideoId);
  closePlayer();
  renderSidebar();
  render();
}

function setRate(rate) {
  state.currentRate = rate;
  els.player.defaultPlaybackRate = rate;
  els.player.playbackRate = rate;
  for (const btn of els.speedButtons.querySelectorAll('button')) {
    btn.classList.toggle('active', Number.parseFloat(btn.dataset.rate) === rate);
  }
}

// ---- コメント機能（mce 由来エンジンの統合。永続化はサイドカーへ write-through） ----

const commentState = {
  item: null, // 対象 item（doc / video 共用。開いているオーバーレイの item）
  comments: [],
  bridge: null, // explanation iframe との postMessage ブリッジ
  sourceText: '', // md のソース（行精緻化用）
  pending: null, // 保存前の選択・フレーム情報
  onPopoverSave: null,
  seq: 1,
};

function resetCommentState() {
  clearHighlights();
  commentState.bridge?.dispose();
  commentState.bridge = null;
  commentState.item = null;
  commentState.comments = [];
  commentState.sourceText = '';
  commentState.pending = null;
  els.commentPanel.textContent = '';
  els.commentCount.textContent = '';
}

function flashButton(btn, label) {
  const orig = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
  }, 1200);
}

async function fetchComments(item) {
  try {
    const res = await fetch(`/api/comments?id=${encodeURIComponent(item.id)}`);
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data.comments) ? data.comments : [];
    return list.map((c, i) => ({ ...c, id: c.id || `c${i + 1}` }));
  } catch (_err) {
    return [];
  }
}

async function persistComments() {
  if (!commentState.item) return;
  try {
    const res = await fetch(`/api/comments?id=${encodeURIComponent(commentState.item.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: commentState.comments }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || String(res.status));
    }
    // 一覧の 💬 バッジ用件数を即時反映（item は state.items 内の同一オブジェクト）
    commentState.item.comments = commentState.comments.length;
  } catch (err) {
    alert(`コメントの保存に失敗しました: ${err.message}\n（対象ファイルの場所が読み取り専用の可能性があります）`);
  }
}

function nextCommentId() {
  const used = new Set(commentState.comments.map((c) => c.id));
  while (used.has(`c${commentState.seq}`)) commentState.seq += 1;
  return `c${commentState.seq++}`;
}

// パネル共通ハンドラ（doc / video 両対応）
function panelHandlers() {
  return {
    onEdit: startEditComment,
    onDelete: async (comment) => {
      if (!confirm('このコメントを削除しますか？')) return;
      commentState.comments = commentState.comments.filter((c) => c.id !== comment.id);
      removeCommentHighlight(comment.id);
      await persistComments();
      refreshCommentPanels();
      restoreDocHighlights();
    },
    onSelect: (comment) => {
      const item = commentState.item;
      if (!item) return;
      if (item.type === 'video') {
        if (comment.timestamp != null) els.player.currentTime = comment.timestamp;
      } else if (item.type === 'explanation') {
        commentState.bridge?.scrollTo({ ...(comment.anchor || {}), quote: comment.quote });
      } else {
        const range = getCommentHighlightRange(comment.id);
        range?.startContainer?.parentElement?.scrollIntoView({ block: 'center' });
      }
    },
    onHoverStart: (comment) => emphasizeCommentHighlight(comment.id),
    onHoverEnd: () => clearEmphasizedHighlight(),
  };
}

function renderDocCommentPanel() {
  renderCommentPanel(els.commentPanel, commentState.comments, panelHandlers());
  els.commentCount.textContent = String(commentState.comments.length);
}

function renderVideoCommentPanel() {
  renderCommentPanel(els.videoCommentPanel, commentState.comments, panelHandlers());
  const has = commentState.comments.length > 0;
  els.videoCommentPane.classList.toggle('hidden', !has);
  els.videoCopyPrompt.classList.toggle('hidden', !has);
  els.videoSendInbox.classList.toggle('hidden', !has);
}

function refreshCommentPanels() {
  if (!commentState.item) return;
  if (commentState.item.type === 'video') renderVideoCommentPanel();
  else renderDocCommentPanel();
}

// md ビュー / explanation iframe のハイライトを保存済みコメントから復元する
function restoreDocHighlights() {
  const item = commentState.item;
  if (!item || item.type === 'video') return;
  if (item.type === 'explanation') {
    // anchor に quote を同送する（data-source-line の無い生成 HTML では
    // iframe-agent が quote テキスト検索で Range を復元するため）
    commentState.bridge?.sendHighlights(
      commentState.comments
        .filter((c) => c.anchor || c.quote)
        .map((c) => ({ ...(c.anchor || {}), quote: c.quote })),
    );
    return;
  }
  clearHighlights();
  for (const c of commentState.comments) {
    if (!c.anchor) continue;
    try {
      const range = rangeFromAnchor(els.mdBody, c.anchor);
      if (range) addCommentHighlight(c.id, range);
    } catch (_err) {}
  }
}

// ---- ポップオーバー ----

function showCommentPopover({ x, y, label, initial = '', onSave }) {
  els.popoverLabel.textContent = label;
  els.popoverText.value = initial;
  els.popover.classList.remove('hidden');
  const rect = els.popover.getBoundingClientRect();
  els.popover.style.left = `${Math.min(Math.max(8, x), window.innerWidth - rect.width - 8)}px`;
  els.popover.style.top = `${Math.min(Math.max(8, y), window.innerHeight - rect.height - 8)}px`;
  commentState.onPopoverSave = onSave;
  els.popoverText.focus();
}

function hideCommentPopover() {
  els.popover.classList.add('hidden');
  els.popoverText.value = '';
  commentState.onPopoverSave = null;
  commentState.pending = null;
  clearPendingHighlight();
}

async function submitPopover() {
  const text = els.popoverText.value.trim();
  if (!text || !commentState.onPopoverSave) return;
  const onSave = commentState.onPopoverSave;
  commentState.onPopoverSave = null;
  await onSave(text);
  hideCommentPopover();
}

function startEditComment(comment) {
  const panel = commentState.item?.type === 'video' ? els.videoCommentPanel : els.commentPanel;
  const itemEl = panel.querySelector(`[data-comment-id="${comment.id}"]`);
  const rect = itemEl?.getBoundingClientRect();
  showCommentPopover({
    x: rect ? rect.left : window.innerWidth / 2 - 160,
    y: rect ? rect.bottom + 4 : window.innerHeight / 2,
    label: 'コメントを編集',
    initial: comment.comment,
    onSave: async (text) => {
      comment.comment = text;
      await persistComments();
      refreshCommentPanels();
    },
  });
}

// ---- 選択 → 新規コメント ----

async function saveNewDocComment(text) {
  const p = commentState.pending;
  if (!p) return;
  const comment = {
    id: nextCommentId(),
    quote: p.quote,
    startLine: p.startLine,
    endLine: p.endLine,
    comment: text,
    anchor: p.anchor,
  };
  commentState.comments.push(comment);
  if (p.range) addCommentHighlight(comment.id, p.range);
  await persistComments();
  renderDocCommentPanel();
  if (commentState.item?.type === 'explanation') restoreDocHighlights();
}

function onIframeSelection(payload) {
  if (!commentState.item || commentState.item.type !== 'explanation') return;
  if (!payload.quote || !payload.quote.trim()) return;
  // explanation（生成 HTML）はソース行の精度に価値がないため quote ベース（行番号 null）
  commentState.pending = {
    quote: payload.quote,
    startLine: null,
    endLine: null,
    anchor: {
      startBlockLine: payload.startBlockLine,
      startOffset: payload.startOffset,
      endBlockLine: payload.endBlockLine,
      endOffset: payload.endOffset,
    },
  };
  const frameRect = els.docFrame.getBoundingClientRect();
  showCommentPopover({
    x: frameRect.left + payload.rect.left,
    y: frameRect.top + payload.rect.top + payload.rect.height + 6,
    label: '選択箇所へのコメント',
    onSave: saveNewDocComment,
  });
}

// ---- 動画フレームコメント ----

async function loadVideoComments(v) {
  resetCommentState();
  commentState.item = v;
  commentState.comments = await fetchComments(v);
  renderVideoCommentPanel();
}

async function saveNewVideoComment(text) {
  const p = commentState.pending;
  if (!p) return;
  commentState.comments.push({
    id: nextCommentId(),
    quote: '',
    startLine: null,
    endLine: null,
    comment: text,
    timestamp: p.timestamp,
    screenshot: p.screenshot,
  });
  await persistComments();
  renderVideoCommentPanel();
}

async function captureFrameAndComment() {
  const video = els.player;
  const item = commentState.item;
  if (!item || item.type !== 'video' || !video.videoWidth) return;
  video.pause();
  const t = Math.round(video.currentTime * 1000);
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    alert('フレームのキャプチャに失敗しました');
    return;
  }
  let framePath;
  try {
    const res = await fetch(`/api/frame?id=${encodeURIComponent(item.id)}&t=${t}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || String(res.status));
    framePath = data.path;
  } catch (err) {
    alert(`フレームの保存に失敗しました: ${err.message}\n（動画の場所が読み取り専用の可能性があります）`);
    return;
  }
  commentState.pending = {
    timestamp: Math.round(video.currentTime * 10) / 10,
    screenshot: framePath,
  };
  const rect = els.frameComment.getBoundingClientRect();
  showCommentPopover({
    x: rect.left,
    y: rect.top - 150,
    label: `${(t / 1000).toFixed(1)}s のフレームにコメント（スクリーンショット保存済み）`,
    onSave: saveNewVideoComment,
  });
}

// ---- コピー（mce 互換 JSON / Claude Code 向けプロンプト） ----

async function copyCommentsAs(kind, btn) {
  const item = commentState.item;
  if (!item) return;
  if (commentState.comments.length === 0) {
    flashButton(btn, 'コメントなし');
    return;
  }
  const exportJson = buildExportJson(item.path, commentState.comments);
  const text =
    kind === 'json' ? JSON.stringify(exportJson, null, 2)
    : item.type === 'video' ? buildVideoPromptText(exportJson)
    : buildPromptText(exportJson);
  try {
    await navigator.clipboard.writeText(text);
    flashButton(btn, 'コピーしました ✓');
  } catch (_err) {
    flashButton(btn, 'コピー失敗');
  }
}

/**
 * コメントを対象プロジェクトの .agent/feedback-inbox/ に書き出し、
 * 取り込みコマンド `/auto-feedback --inbox <書き出し先>` をクリップボードへコピーする
 */
async function sendToInbox(btn) {
  const item = commentState.item;
  if (!item) return;
  if (commentState.comments.length === 0) {
    flashButton(btn, 'コメントなし');
    return;
  }
  try {
    const res = await fetch(`/api/feedback-inbox?id=${encodeURIComponent(item.id)}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    try {
      await navigator.clipboard.writeText(`/auto-feedback --inbox ${data.path}`);
      flashButton(btn, '保存＋コマンドコピー ✓');
    } catch (_err) {
      flashButton(btn, '保存 ✓（コピー失敗）');
    }
  } catch (err) {
    flashButton(btn, `保存失敗: ${String(err.message).slice(0, 40)}`);
  }
}

els.search.addEventListener('input', (e) => {
  state.filterText = e.target.value;
  render();
});
els.rescan.addEventListener('click', rescan);
els.expandAll.addEventListener('click', expandAll);
els.collapseAll.addEventListener('click', collapseAll);
els.playerClose.addEventListener('click', closePlayer);
/** モーダルの最大化トグル（doc / player 共通。状態は開き直しても維持） */
function toggleMaximize(overlay, btn) {
  const on = overlay.classList.toggle('maximized');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
els.playerMaximize.addEventListener('click', () => toggleMaximize(els.playerOverlay, els.playerMaximize));
els.docMaximize.addEventListener('click', () => toggleMaximize(els.docOverlay, els.docMaximize));
els.playerLoop.addEventListener('click', () => {
  state.loop = !state.loop;
  els.player.loop = state.loop;
  els.playerLoop.classList.toggle('active', state.loop);
  els.playerLoop.setAttribute('aria-pressed', state.loop ? 'true' : 'false');
});
els.playerOverlay.addEventListener('click', (e) => {
  if (e.target === els.playerOverlay) closePlayer();
});
els.docClose.addEventListener('click', closeDoc);
els.docOverlay.addEventListener('click', (e) => {
  if (e.target === els.docOverlay) closeDoc();
});

// md ビュー上のハイライトにホバー → パネルの該当コメントを強調（mce FB1 の座標ヒットテスト）
let hoveredCommentId = null;
els.mdBody.addEventListener('mousemove', (e) => {
  const id = findCommentIdAtPoint(e.clientX, e.clientY);
  if (id === hoveredCommentId) return;
  // パネル項目の強調を付け替え
  if (hoveredCommentId) {
    els.commentPanel
      .querySelector(`[data-comment-id="${hoveredCommentId}"]`)
      ?.classList.remove('hover-active');
  }
  hoveredCommentId = id;
  if (id) {
    emphasizeCommentHighlight(id);
    const panelItem = els.commentPanel.querySelector(`[data-comment-id="${id}"]`);
    panelItem?.classList.add('hover-active');
    panelItem?.scrollIntoView({ block: 'nearest' });
  } else {
    clearEmphasizedHighlight();
  }
});
els.mdBody.addEventListener('mouseleave', () => {
  if (!hoveredCommentId) return;
  els.commentPanel
    .querySelector(`[data-comment-id="${hoveredCommentId}"]`)
    ?.classList.remove('hover-active');
  hoveredCommentId = null;
  clearEmphasizedHighlight();
});

// md ビューでのテキスト選択 → コメントポップオーバー
els.mdBody.addEventListener('mouseup', () => {
  const item = commentState.item;
  if (!item || item.type === 'explanation' || item.type === 'video') return;
  if (!els.popover.classList.contains('hidden')) return;
  const captured = captureSelection(els.mdBody, commentState.sourceText);
  if (!captured || !captured.quote.trim()) return;
  commentState.pending = captured;
  setPendingHighlight(captured.range);
  const rect = captured.range.getBoundingClientRect();
  showCommentPopover({
    x: rect.left,
    y: rect.bottom + 6,
    label: captured.startLine === captured.endLine
      ? `L${captured.startLine} へのコメント`
      : `L${captured.startLine}-${captured.endLine} へのコメント`,
    onSave: saveNewDocComment,
  });
});

els.popoverSave.addEventListener('click', submitPopover);
els.popoverCancel.addEventListener('click', hideCommentPopover);
els.popoverText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitPopover();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    hideCommentPopover();
  }
});
els.copyJson.addEventListener('click', () => copyCommentsAs('json', els.copyJson));
els.copyPrompt.addEventListener('click', () => copyCommentsAs('prompt', els.copyPrompt));
els.videoCopyPrompt.addEventListener('click', () => copyCommentsAs('prompt', els.videoCopyPrompt));
els.sendInbox.addEventListener('click', () => sendToInbox(els.sendInbox));
els.videoSendInbox.addEventListener('click', () => sendToInbox(els.videoSendInbox));
els.frameComment.addEventListener('click', captureFrameAndComment);
els.playerPrev.addEventListener('click', () => playAdjacent(-1));
els.playerNext.addEventListener('click', () => playAdjacent(1));
document.addEventListener('keydown', (e) => {
  // ポップオーバー表示中は Esc でポップオーバーだけ閉じる
  if (!els.popover.classList.contains('hidden')) {
    if (e.key === 'Escape') hideCommentPopover();
    return;
  }
  if (!els.docOverlay.classList.contains('hidden')) {
    if (e.key === 'Escape') closeDoc();
    return;
  }
  if (els.playerOverlay.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    closePlayer();
    return;
  }
  // 動画本体にフォーカスがあるときはネイティブのシーク操作を優先する
  if (e.target === els.player) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    playAdjacent(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    playAdjacent(1);
  }
});
els.playerDelete.addEventListener('click', deleteCurrentVideo);
els.speedButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-rate]');
  if (!btn) return;
  setRate(Number.parseFloat(btn.dataset.rate));
});

els.player.addEventListener('loadedmetadata', applyRate);
els.player.addEventListener('canplay', applyRate);
els.player.addEventListener('playing', applyRate);
els.player.addEventListener('ratechange', () => {
  if (Math.abs(els.player.playbackRate - state.currentRate) > 0.001) {
    els.player.playbackRate = state.currentRate;
  }
});

loadItems();
