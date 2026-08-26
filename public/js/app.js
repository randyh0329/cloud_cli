/* eslint-env browser */
'use strict';

/**
 * Tab manager.
 *
 * One <div class="pane"> + one xterm.js instance per project. Switching tabs
 * only toggles a CSS class: the inactive pane is hidden, never destroyed, so
 * the WebSocket stays open and there is no reconnect churn (spec §3.4).
 * Terminals are created lazily on a tab's first activation — a hidden element
 * has no size, so xterm cannot be sized correctly before then.
 */

const $ = (sel) => document.querySelector(sel);

const els = {
  tabs: $('#tabs'),
  panes: $('#panes'),
  empty: $('#empty'),
  emptyHealth: $('#empty-health'),
  toasts: $('#toasts'),
  dialog: $('#new-dialog'),
  slug: $('#f-slug'),
  cwd: $('#f-cwd'),
  formError: $('#f-error'),
  create: $('#f-create'),
};

const LAST_TAB_KEY = 'webterm.lastTab';
// Kept in sync with server/slug.js; the server remains the authority.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** slug -> {project, tab, dot, pane, overlay, term|null} */
const tabs = new Map();
let activeSlug = null;

// ── api ────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.detail = data && data.detail;
    throw err;
  }
  return data;
}

// ── toasts ─────────────────────────────────────────────────────────────

function toast(message, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/** Turn an API error into something worth reading, including 503 preflight detail. */
function describe(err) {
  const problems = err.detail && err.detail.problems;
  if (Array.isArray(problems) && problems.length) {
    return `${err.message}\n\n${problems.map((p) => `• ${p.message}`).join('\n')}`;
  }
  if (err.detail && err.detail.journal) return `${err.message}\n\n${err.detail.journal}`;
  return err.message;
}

// ── tabs ───────────────────────────────────────────────────────────────

function buildTab(project) {
  const slug = project.slug;

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'tab';
  tab.setAttribute('role', 'tab');
  tab.dataset.slug = slug;
  tab.setAttribute('aria-selected', 'false');
  tab.title = `${slug} — ${project.cwd}\nRight-click (or long-press) to delete`;

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.dataset.state = 'idle';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = slug;
  tab.append(dot, name);

  tab.addEventListener('click', () => activate(slug));

  // Delete: right-click on a pointer device, long-press on a touch one (spec §3.4).
  tab.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    confirmDelete(slug);
  });
  let pressTimer = null;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  tab.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse') return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      confirmDelete(slug);
    }, 600);
  });
  for (const e of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) {
    tab.addEventListener(e, cancelPress);
  }

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.slug = slug;
  pane.dataset.state = 'idle';

  const mount = document.createElement('div');
  mount.className = 'term';

  const overlay = document.createElement('div');
  overlay.className = 'pane-overlay';
  const msg = document.createElement('div');
  msg.className = 'msg';
  const sub = document.createElement('div');
  sub.className = 'sub';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Reconnect now';
  retry.addEventListener('click', () => {
    const entry = tabs.get(slug);
    if (entry && entry.term) entry.term.retryNow();
  });
  overlay.append(msg, sub, retry);
  pane.append(mount, overlay);

  els.tabs.append(tab);
  els.panes.append(pane);

  const entry = { project, tab, dot, pane, mount, overlay, msg, sub, term: null };
  tabs.set(slug, entry);
  return entry;
}

function removeTab(slug) {
  const entry = tabs.get(slug);
  if (!entry) return;
  if (entry.term) entry.term.dispose();
  entry.tab.remove();
  entry.pane.remove();
  tabs.delete(slug);
  if (activeSlug === slug) {
    activeSlug = null;
    const nextSlug = tabs.keys().next().value;
    if (nextSlug) activate(nextSlug);
  }
  refreshEmptyState();
}

function onTermState(slug, state, detail) {
  const entry = tabs.get(slug);
  if (!entry) return;
  if (state === 'title') {
    entry.tab.title = `${slug} — ${detail}\nRight-click (or long-press) to delete`;
    return;
  }
  entry.dot.dataset.state = state;
  entry.pane.dataset.state = state;
  if (state === 'down') {
    entry.msg.textContent = `ttyd for "${slug}" is not running.`;
    entry.sub.textContent = `systemctl --user status ttyd@${slug}.service`;
  } else if (state === 'closed' || state === 'error') {
    entry.msg.textContent = 'Disconnected. Retrying…';
    entry.sub.textContent = detail || '';
  }
}

function activate(slug) {
  const entry = tabs.get(slug);
  if (!entry) return;

  if (activeSlug && tabs.has(activeSlug)) {
    const prev = tabs.get(activeSlug);
    prev.pane.classList.remove('active');
    prev.tab.setAttribute('aria-selected', 'false');
  }
  activeSlug = slug;
  entry.pane.classList.add('active');
  entry.tab.setAttribute('aria-selected', 'true');
  entry.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  els.empty.hidden = true;
  try {
    localStorage.setItem(LAST_TAB_KEY, slug);
  } catch {
    /* private mode; the tab still works, it just won't be restored */
  }

  if (!entry.term) {
    entry.term = new window.TtydTerminal({
      slug,
      mount: entry.mount,
      onState: (state, detail) => onTermState(slug, state, detail),
    });
    entry.term.open();
  } else {
    entry.term.fit();
  }
  entry.term.focus();
}

function refreshEmptyState() {
  const none = tabs.size === 0;
  els.empty.hidden = !none;
  if (none) activeSlug = null;
}

// ── load / create / delete ─────────────────────────────────────────────

async function loadProjects() {
  let projects;
  try {
    projects = (await api('GET', '/api/projects')).projects;
  } catch (err) {
    toast(`Could not load projects: ${err.message}`, 'error', 9000);
    return;
  }

  const seen = new Set();
  for (const project of projects) {
    seen.add(project.slug);
    const existing = tabs.get(project.slug);
    if (existing) existing.project = project;
    else buildTab(project);
  }
  // Projects deleted by someone else (curl, another tab) disappear here.
  for (const slug of [...tabs.keys()]) if (!seen.has(slug)) removeTab(slug);

  refreshEmptyState();
  if (tabs.size && (!activeSlug || !tabs.has(activeSlug))) {
    let remembered = null;
    try {
      remembered = localStorage.getItem(LAST_TAB_KEY);
    } catch {
      /* ignore */
    }
    activate(tabs.has(remembered) ? remembered : tabs.keys().next().value);
  }
  return projects;
}

async function reportHealth() {
  try {
    const health = await api('GET', '/api/health');
    if (health.ok) {
      els.emptyHealth.textContent = '';
      return;
    }
    const problems = (health.supervisor && health.supervisor.problems) || [];
    const text = problems.map((p) => `${p.fatal ? 'ERROR' : 'warn'}  ${p.message}`).join('\n');
    els.emptyHealth.textContent = text;
    if (problems.some((p) => p.fatal)) {
      toast(`Host not ready:\n${text}`, 'error', 12000);
    }
  } catch {
    /* /api/health is advisory; a failure here must not block the UI */
  }
}

function openNewDialog() {
  els.slug.value = '';
  els.cwd.value = '';
  els.formError.hidden = true;
  els.create.disabled = false;
  els.dialog.showModal();
  els.slug.focus();
}

async function submitNewProject() {
  const slug = els.slug.value.trim();
  const cwd = els.cwd.value.trim();

  if (!SLUG_RE.test(slug)) {
    els.formError.textContent =
      'Slug must be lowercase letters, digits and hyphens (max 32), not starting or ending with a hyphen.';
    els.formError.hidden = false;
    els.dialog.showModal();
    els.slug.focus();
    return;
  }

  els.create.disabled = true;
  const pending = toast(`Creating "${slug}"…`, 'info', 60000);
  try {
    const project = await api('POST', '/api/projects', cwd ? { slug, cwd } : { slug });
    pending.remove();
    toast(`Created "${slug}" on port ${project.port}`, 'ok');
    if (!tabs.has(slug)) buildTab(project);
    refreshEmptyState();
    activate(slug);
  } catch (err) {
    pending.remove();
    els.formError.textContent = describe(err);
    els.formError.hidden = false;
    els.create.disabled = false;
    els.dialog.showModal();
    els.slug.focus();
  }
}

async function confirmDelete(slug) {
  const ok = window.confirm(
    `Delete project "${slug}"?\n\n` +
      'This stops its ttyd service and kills its tmux session — anything running in it is lost.\n' +
      'Pasted screenshots are kept on disk.'
  );
  if (!ok) return;

  const pending = toast(`Deleting "${slug}"…`, 'info', 60000);
  try {
    await api('DELETE', `/api/projects/${encodeURIComponent(slug)}`);
    pending.remove();
    removeTab(slug);
    toast(`Deleted "${slug}"`, 'ok');
  } catch (err) {
    pending.remove();
    toast(`Could not delete "${slug}": ${describe(err)}`, 'error', 9000);
  }
}

// ── wiring ─────────────────────────────────────────────────────────────

$('#new-project').addEventListener('click', openNewDialog);
$('#empty-new').addEventListener('click', openNewDialog);

els.dialog.addEventListener('close', () => {
  if (els.dialog.returnValue === 'create') submitNewProject();
});

window.addEventListener('resize', () => {
  const entry = activeSlug && tabs.get(activeSlug);
  if (entry && entry.term) entry.term.fit();
});

// Refit after the on-screen keyboard or browser chrome settles on mobile.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const entry = activeSlug && tabs.get(activeSlug);
    if (entry && entry.term) entry.term.fit();
  });
}

/** Small surface for milestone 5 (paste-to-screenshot) and for tests. */
window.webterm = {
  activeSlug: () => activeSlug,
  tabs,
  toast,
  reload: loadProjects,
};

loadProjects().then(reportHealth);
