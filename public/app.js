const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { projects: [], id: null, tab: 'tasks', tasks: [], open: new Set(), logs: {}, env: {}, draft: null, q: '', sort: 'az', tq: '', range: 'all', from: '', to: '' };
try { const s = localStorage.getItem('qa-sort'); if (['az', 'za', 'new', 'old'].includes(s)) state.sort = s; } catch {}
$('#projSort').value = state.sort;
let pollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

const cur = () => state.projects.find((p) => p.id === state.id);

// ---------- sidebar ----------
const SORTS = {
  az: (a, b) => a.name.localeCompare(b.name),
  za: (a, b) => b.name.localeCompare(a.name),
  new: (a, b) => b.createdAt.localeCompare(a.createdAt),
  old: (a, b) => a.createdAt.localeCompare(b.createdAt),
};

const AVATARS = ['#0c66e4', '#1f845a', '#946f00', '#c9372c', '#6e5dc6', '#e56910', '#206a83', '#ae4787'];
const avatarColor = (name) => AVATARS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATARS.length];

function renderSide() {
  const q = state.q.trim().toLowerCase();
  const list = state.projects.filter((p) => p.name.toLowerCase().includes(q)).sort(SORTS[state.sort]);
  $('#projects').innerHTML = list.length
    ? list.map((p) => `<button class="proj" data-id="${p.id}" aria-current="${p.id === state.id}"><span class="avatar" aria-hidden="true" style="background:${avatarColor(p.name)}">${esc(p.name.trim()[0] || '?').toUpperCase()}</span><span class="pname">${esc(p.name)}</span></button>`).join('')
    : `<p class="hint" role="status">${state.projects.length ? 'No matching projects' : 'No projects yet'}</p>`;
}

$('#projSearch').addEventListener('input', (e) => { state.q = e.target.value; renderSide(); });
$('#projSort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  try { localStorage.setItem('qa-sort', state.sort); } catch {}
  renderSide();
});

$('#projects').addEventListener('click', (e) => {
  const b = e.target.closest('.proj');
  if (b) selectProject(b.dataset.id);
});
$('#newProject').addEventListener('click', () => { state.id = null; state.tab = 'settings'; renderAll(); });

async function selectProject(id) {
  state.id = id;
  state.tab = 'tasks';
  state.open.clear();
  state.logs = {};
  state.draft = null;
  await loadTasks();
  renderAll();
}

// ---------- main ----------
function renderAll() {
  renderSide();
  const p = cur();
  const main = $('#main');
  if (!p && state.tab !== 'settings') {
    main.innerHTML = '<div class="empty"><h2>No project yet</h2><p>Create a project to start running QA.</p></div>';
    return;
  }
  const tabs = p ? ['tasks', 'context', 'settings'] : ['settings'];
  const slack = p && p.slackChannel ? p.slackChannel.split(' ')[0] : '';
  main.innerHTML = `
    <div class="page-head"><div class="page-id">
    <nav class="crumbs" aria-label="Breadcrumb">Projects / <span aria-current="page">${p ? esc(p.name) : 'New project'}</span></nav>
    <h1 class="page-title">${p ? esc(p.name) : 'New project'}</h1>
    ${p && (p.jiraProject || slack) ? `<div class="meta-line">${p.jiraProject ? `<span class="pill">Jira · ${esc(p.jiraProject)}</span>` : ''}${slack ? `<span class="pill">Slack · ${esc(slack)}</span>` : ''}</div>` : ''}
    </div><div id="headTools" class="hist-tools head-tools"></div></div>
    <div class="tabs" role="tablist">
      ${tabs.map((t) => `<button class="tab" role="tab" data-tab="${t}" aria-selected="${t === state.tab}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <section id="panel" role="tabpanel"></section>`;
  main.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) { state.tab = b.dataset.tab; renderAll(); }
  });
  ({ tasks: renderTasks, context: renderContext, settings: renderSettings })[state.tab]();
}

// ---------- settings ----------
function renderSettings() {
  const p = cur() || { permissionMode: 'acceptEdits', allowedTools: state.env.defaultTools };
  const f = (id, label, hint, val, ph = '') => `
    <div class="field"><label for="${id}">${label}</label>
    <input type="text" id="${id}" value="${esc(val)}" placeholder="${esc(ph)}" autocomplete="off">${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
  $('#panel').innerHTML = `
    <form id="settingsForm" class="card">
      ${f('name', 'Project name', '', p.name, 'Acme Store')}
      ${f('folder', 'Workspace folder', 'Absolute path. The agent works here; run artifacts go in <code>qa-runs/</code>. Leave empty for a managed folder.', p.folder, '/path/to/workspace')}
      <h3>Jira</h3>
      <div class="grid2">
        ${f('jiraProject', 'Project key', '', p.jiraProject, 'QA')}
        ${f('jiraBoard', 'Board / Kanban name or URL', '', p.jiraBoard, 'QA board or board URL')}
      </div>
      <h3>Slack</h3>
      <div class="grid2">
        ${f('slackChannel', 'Channel', 'Run summaries', p.slackChannel, '#qa-reports')}
        ${f('slackAlertChannel', 'Alert channel (optional)', 'Critical findings', p.slackAlertChannel, '#qa-alerts')}
      </div>
      <h3>Unattended runs</h3>
      <div class="field"><label for="allowedTools">Allowed tools</label>
        <textarea id="allowedTools">${esc(p.allowedTools)}</textarea>
        <p class="hint">Comma-separated. Unattended tasks cannot ask for permission, so anything not listed is denied.</p></div>
      ${f('model', 'Model (unattended)', 'Model id passed to claude --model. Cheaper models cost less per run.', p.model || state.env.defaultModel, 'claude-sonnet-5-5')}
      <div class="field"><label for="permissionMode">Permission mode</label>
        <select id="permissionMode">
          <option value="acceptEdits" ${p.permissionMode === 'acceptEdits' ? 'selected' : ''}>Accept edits (recommended)</option>
          <option value="bypassPermissions" ${p.permissionMode === 'bypassPermissions' ? 'selected' : ''}>Bypass all permissions (dangerous)</option>
        </select></div>
      <div class="row spread">
        <button class="btn" type="submit">${cur() ? 'Save settings' : 'Create project'}</button>
        ${cur() ? '<button class="btn danger" type="button" id="delProject">Delete project</button>' : ''}
      </div>
      <p class="err" id="formErr" role="alert"></p>
    </form>`;
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    ['name', 'folder', 'jiraProject', 'jiraBoard', 'slackChannel', 'slackAlertChannel', 'allowedTools', 'permissionMode', 'model']
      .forEach((k) => { body[k] = $(`#${k}`).value; });
    try {
      const saved = cur() ? await api(`/projects/${state.id}`, { method: 'PUT', body }) : await api('/projects', { method: 'POST', body });
      await loadProjects();
      state.id = saved.id;
      toast('Saved');
      state.tab = cur() && !p.id ? 'context' : state.tab;
      await loadTasks();
      renderAll();
    } catch (err) { $('#formErr').textContent = err.message; }
  });
  const del = $('#delProject');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete "${p.name}" and its task history? The workspace folder is kept.`)) return;
    await api(`/projects/${state.id}`, { method: 'DELETE' });
    await loadProjects();
    state.id = state.projects[0]?.id || null;
    state.tab = 'tasks';
    await loadTasks();
    renderAll();
  });
}

// ---------- context ----------
function renderContext() {
  const p = cur();
  $('#panel').innerHTML = `
    <div class="card">
      <h3>URLs</h3>
      <label for="contextUrls" class="hint" style="margin:0 0 6px">One per line: site, staging, API docs, Jira board, specs…</label>
      <textarea id="contextUrls">${esc(p.contextUrls)}</textarea>
      <h3 style="margin-top:16px">Notes</h3>
      <label for="contextNotes" class="hint" style="margin:0 0 6px">Anything the agent should know: environments, test tenants (never credentials), known issues.</label>
      <textarea id="contextNotes">${esc(p.contextNotes)}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn" id="saveCtx">Save context</button></div>
    </div>
    <div class="card">
      <h3>Documents</h3>
      <div id="docs">${docsHtml(p)}</div>
      <div class="row" style="margin-top:12px">
        <label class="btn ghost" for="docInput" style="margin:0;cursor:pointer">Add documents</label>
        <input type="file" id="docInput" multiple style="position:absolute;opacity:0;width:1px;height:1px">
        <span class="hint">Specs, golden datasets, release notes, test plans.</span>
      </div>
    </div>`;
  $('#saveCtx').addEventListener('click', async () => {
    await api(`/projects/${state.id}`, { method: 'PUT', body: { contextUrls: $('#contextUrls').value, contextNotes: $('#contextNotes').value } });
    await loadProjects();
    toast('Context saved');
  });
  $('#docInput').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const data = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.readAsDataURL(file);
      });
      await api(`/projects/${state.id}/docs`, { method: 'POST', body: { name: file.name, data } });
    }
    await loadProjects();
    $('#docs').innerHTML = docsHtml(cur());
    toast('Uploaded');
  });
  $('#docs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    await api(`/projects/${state.id}/docs/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
    await loadProjects();
    $('#docs').innerHTML = docsHtml(cur());
  });
}
const docsHtml = (p) => p.docs.length
  ? p.docs.map((d) => `<div class="doc"><span>${esc(d.name)} <span class="hint">${(d.size / 1024).toFixed(1)} KB</span></span><button class="btn ghost small" data-del="${esc(d.name)}">Remove</button></div>`).join('')
  : '<p class="hint">No documents yet.</p>';

// ---------- tasks ----------
function renderTasks() {
  const p = cur();
  const d = state.draft || { instructions: '', urls: '', commands: '', unattended: false, dryRun: true };
  $('#headTools').innerHTML = `
    <label class="sr" for="taskSearch">Search tasks</label>
    <input type="search" id="taskSearch" placeholder="Search tasks" autocomplete="off" value="${esc(state.tq)}">
    <label class="sr" for="taskRange">Date range</label>
    <select id="taskRange">
      ${[['all', 'All time'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Custom range…']]
        .map(([v, l]) => `<option value="${v}" ${state.range === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    <div class="range-custom" id="rangeCustom" ${state.range === 'custom' ? '' : 'hidden'}>
      <label>From <input type="datetime-local" id="taskFrom" value="${esc(state.from)}"></label>
      <label>To <input type="datetime-local" id="taskTo" value="${esc(state.to)}"></label>
    </div>`;
  $('#panel').innerHTML = `
    <div class="cols">
    <section class="col-history" aria-labelledby="histTitle">
      <div class="row spread hist-head">
        <div class="hist-title"><h3 id="histTitle">Previous tasks</h3><span class="hint" id="taskCount" role="status"></span></div>
        <button class="btn ghost small" id="refresh" type="button">Refresh</button>
      </div>
      <div id="history"></div>
    </section>
    <form id="taskForm" class="card col-new">
      <h3>New QA task</h3>
      <div class="field"><label for="instructions">Instructions</label>
        <textarea id="instructions" required placeholder="e.g. Full public-site audit: links, SEO, WCAG 2.2 AA. Report regressions vs last run.">${esc(d.instructions)}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="urls">URLs in scope</label>
          <textarea id="urls" placeholder="Empty = use project context URLs">${esc(d.urls)}</textarea></div>
        <div class="field"><label for="commands">Commands / skills</label>
          <textarea id="commands" placeholder="/qa-agent scan&#10;/audit">${esc(d.commands)}</textarea></div>
      </div>
      <div class="grid2">
        <label class="switch" for="unattended" style="margin:0">
          <input type="checkbox" id="unattended" role="switch" ${d.unattended ? 'checked' : ''}>
          <span class="track" aria-hidden="true"></span>
          <span><strong id="modeLabel"></strong><span class="hint" id="modeHint" style="display:block"></span></span>
        </label>
        <label class="switch" for="dryRun" style="margin:0">
          <input type="checkbox" id="dryRun" role="switch" ${d.dryRun ? 'checked' : ''}>
          <span class="track" aria-hidden="true"></span>
          <span><strong id="dryLabel"></strong><span class="hint" id="dryHint" style="display:block"></span></span>
        </label>
      </div>
      <div class="row" style="margin-top:14px"><button class="btn" type="submit" id="startBtn">Start task</button></div>
      <p class="err" id="taskErr" role="alert"></p>
    </form>
    </div>`;
  const sync = () => {
    const u = $('#unattended').checked, dr = $('#dryRun').checked;
    $('#modeLabel').textContent = u ? 'Unattended' : 'Interactive';
    $('#modeHint').textContent = u ? 'Runs headless in the background. Log appears below.' : (state.env.platform === 'darwin' ? 'Opens Claude in Terminal so you can steer and approve.' : 'Needs macOS Terminal.');
    $('#dryLabel').textContent = dr ? 'Dry run' : 'Live';
    $('#dryHint').textContent = dr ? 'Drafts Jira tickets and Slack messages only.' : `Files tickets in ${p.jiraProject || '(no Jira project)'} and posts to ${p.slackChannel || '(no channel)'}.`;
    state.draft = { instructions: $('#instructions').value, urls: $('#urls').value, commands: $('#commands').value, unattended: u, dryRun: dr };
  };
  $('#taskForm').addEventListener('input', sync);
  sync();
  $('#taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    sync();
    const dd = state.draft;
    $('#startBtn').disabled = true;
    try {
      const t = await api(`/projects/${state.id}/tasks`, { method: 'POST', body: { instructions: dd.instructions, urls: dd.urls, commands: dd.commands, mode: dd.unattended ? 'unattended' : 'interactive', dryRun: dd.dryRun } });
      state.open.add(t.id);
      await loadTasks();
      renderHistory();
      toast(t.mode === 'unattended' ? 'Task started' : 'Opened in Terminal');
    } catch (err) { $('#taskErr').textContent = err.message; }
    $('#startBtn').disabled = false;
  });
  $('#history').addEventListener('toggle', (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    if (e.target.open) { state.open.add(id); refreshLog(id); } else state.open.delete(id);
  }, true);
  $('#history').addEventListener('click', onHistoryClick);
  const filt = () => {
    state.tq = $('#taskSearch').value;
    state.range = $('#taskRange').value;
    state.from = $('#taskFrom').value;
    state.to = $('#taskTo').value;
    $('#rangeCustom').hidden = state.range !== 'custom';
    renderHistory();
  };
  ['#taskSearch', '#taskRange', '#taskFrom', '#taskTo'].forEach((s) => $(s).addEventListener('input', filt));
  $('#refresh').addEventListener('click', async () => {
    const b = $('#refresh');
    b.disabled = true;
    try {
      await loadTasks();
      await Promise.all([...state.open].map(refreshLog));
      renderHistory();
      toast('Refreshed');
    } finally { b.disabled = false; }
  });
  renderHistory();
  schedulePoll();
}

async function loadTasks() {
  state.tasks = state.id ? await api(`/projects/${state.id}/tasks`) : [];
}
async function refreshLog(id) {
  const t = await api(`/projects/${state.id}/tasks/${id}`);
  state.logs[id] = t.log;
  const pre = $(`pre[data-log="${id}"]`);
  if (pre) { const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20; pre.textContent = t.log || '(no output yet)'; if (atEnd) pre.scrollTop = pre.scrollHeight; }
}

const live = (t) => t.status === 'running' || t.status === 'interactive';
const dur = (t) => {
  const s = Math.round(((t.endedAt ? new Date(t.endedAt) : new Date()) - new Date(t.startedAt)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function groupOf(ts) {
  const day = 864e5;
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const t = new Date(ts).getTime();
  if (t >= today) return 'Today';
  if (t >= today - day) return 'Yesterday';
  if (t >= today - 6 * day) return 'Last 7 days';
  if (t >= today - 29 * day) return 'Last 30 days';
  return 'Older';
}

const STATUS = { done: 'OK', failed: 'Fail', cancelled: 'Cancelled', running: 'Running', interactive: 'In Terminal' };

function visibleTasks() {
  const q = state.tq.trim().toLowerCase();
  const day = 864e5;
  let from = null;
  let to = null;
  if (state.range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); from = d.getTime(); }
  else if (state.range === '7d') from = Date.now() - 7 * day;
  else if (state.range === '30d') from = Date.now() - 30 * day;
  else if (state.range === 'custom') {
    from = state.from ? new Date(state.from).getTime() : null;
    to = state.to ? new Date(state.to).getTime() : null;
  }
  return state.tasks.filter((t) => {
    const ts = new Date(t.startedAt).getTime();
    if (from != null && ts < from) return false;
    if (to != null && ts > to) return false;
    if (!q) return true;
    const hay = [t.instructions, STATUS[t.status], t.status, t.mode, t.result?.summary, ...(t.links || []).map((l) => l.url)].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderHistory() {
  const h = $('#history');
  if (!h) return;
  const tasks = visibleTasks();
  $('#taskCount').textContent = state.tasks.length ? `${tasks.length} of ${state.tasks.length}` : '';
  if (!state.tasks.length) { h.innerHTML = '<p class="hint">No tasks yet. Start one with the form.</p>'; return; }
  if (!tasks.length) { h.innerHTML = '<p class="hint">No tasks match the filters.</p>'; return; }
  let lastGroup = '';
  h.innerHTML = tasks.map((t) => {
    const g = groupOf(t.startedAt);
    const head = g !== lastGroup ? `<h4 class="grp">${g}</h4>` : '';
    lastGroup = g;
    const r = t.result;
    const c = r?.counts;
    const jira = (r?.jira || []).filter((j) => j.url).map((j) => ({ url: j.url, label: j.key || 'Jira', kind: 'jira' }));
    const slack = (r?.slack || []).filter((s) => s.url).map((s) => ({ url: s.url, label: s.channel || 'Slack', kind: 'slack' }));
    const seen = new Set([...jira, ...slack].map((l) => l.url));
    const extra = (t.links || []).filter((l) => !seen.has(l.url)).map((l) => ({ ...l, label: l.kind === 'slack' ? 'Slack' : 'Jira' }));
    const links = [...jira, ...slack, ...extra];
    return head + `<details class="task" data-id="${t.id}" ${state.open.has(t.id) ? 'open' : ''}>
      <summary>
        <span class="t-meta">${new Date(t.startedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' })}</span>
        <span class="t-meta">${new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="badge ${t.status}">${STATUS[t.status] || t.status}</span>
        <span class="t-title">${esc(t.instructions.split('\n')[0])}</span>
        <span class="t-meta">${dur(t)}</span>
        <span class="pills"><span class="pill">${t.mode}</span><span class="pill">${t.dryRun ? 'dry run' : 'live'}</span></span>
      </summary>
      <div class="task-body">
        <p class="instr">${esc(t.instructions)}</p>
        ${c ? `<div class="row"><span class="badge failed">${c.critical || 0} critical</span><span class="badge warn">${c.serious || 0} serious</span><span class="badge">${c.moderate || 0} moderate</span><span class="badge">${c.minor || 0} minor</span></div>` : ''}
        ${r?.summary ? `<p>${esc(r.summary)}</p>` : ''}
        ${r?.blocked?.length ? `<p class="err">Blocked: ${esc(r.blocked.join('; '))}</p>` : ''}
        ${t.warning ? `<p class="hint">${esc(t.warning)}</p>` : ''}
        ${t.error ? `<p class="err">${esc(t.error)}</p>` : ''}
        ${links.length ? `<div class="chips">${links.map((l) => `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${l.kind === 'slack' ? 'Slack' : 'Jira'}: ${esc(l.label)}</a>`).join('')}</div>` : ''}
        <div class="row">
          ${live(t) ? `<button class="btn ghost small" data-act="cancel" data-id="${t.id}">Cancel</button>` : ''}
          ${t.status === 'interactive' ? `<button class="btn ghost small" data-act="complete" data-id="${t.id}">Mark done</button>` : ''}
          <button class="btn ghost small" data-act="rerun" data-id="${t.id}">Re-run</button>
          <span class="hint">Artifacts: ${esc(t.runDir)}</span>
        </div>
        <pre class="log" data-log="${t.id}" tabindex="0" aria-label="Task log">${esc(state.logs[t.id] ?? (t.mode === 'interactive' ? 'Running in Terminal. This task completes when the agent writes result.json, or use Mark done.' : '(loading)'))}</pre>
      </div></details>`;
  }).join('');
  for (const id of state.open) if (!state.logs[id]) refreshLog(id);
}

async function onHistoryClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'cancel') await api(`/projects/${state.id}/tasks/${id}/cancel`, { method: 'POST' });
  if (b.dataset.act === 'complete') await api(`/projects/${state.id}/tasks/${id}/complete`, { method: 'POST' });
  if (b.dataset.act === 'rerun') {
    const t = state.tasks.find((x) => x.id === id);
    state.draft = { instructions: t.instructions, urls: t.urls.join('\n'), commands: t.commands.join('\n'), unattended: t.mode === 'unattended', dryRun: t.dryRun };
    renderTasks();
    $('#instructions').focus();
    return;
  }
  await loadTasks();
  renderHistory();
}

function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (state.tab !== 'tasks' || !state.id) return;
    const wasLive = state.tasks.some(live);
    if (!wasLive) return;
    await loadTasks();
    for (const id of state.open) { const t = state.tasks.find((x) => x.id === id); if (t && (live(t) || !state.logs[id])) await refreshLog(id); }
    // keep summary rows fresh without clobbering open logs
    const scroll = Object.fromEntries([...document.querySelectorAll('pre.log')].map((p) => [p.dataset.log, p.scrollTop]));
    renderHistory();
    document.querySelectorAll('pre.log').forEach((p) => { if (scroll[p.dataset.log] != null) p.scrollTop = scroll[p.dataset.log]; });
  }, 2500);
}

// ---------- connections: gear, panel, welcome ----------
const CONNECTORS_URL = 'https://claude.ai/settings/connectors';
const conn = { items: [], checking: true, loaded: false };
let connPollTimer = null;

const BAD = ['missing', 'needs-auth', 'failed'];
const ledClass = (st) => (BAD.includes(st) ? 'red' : st === 'degraded' ? 'amber' : st === 'ok' ? '' : 'grey');
const connBad = () => conn.items.filter((i) => BAD.includes(i.state));

async function loadStatus(force) {
  try {
    const d = await api(`/status${force ? '?refresh=1' : ''}`);
    conn.items = d.items;
    conn.checking = d.checking;
    conn.loaded = d.items.length > 0;
  } catch { conn.checking = false; }
  renderGear();
  renderConnPanel();
  renderWelcome();
  clearTimeout(connPollTimer);
  connPollTimer = setTimeout(() => loadStatus(false), conn.checking ? 1500 : 60000);
}

function renderGear() {
  const bad = connBad();
  const degraded = conn.items.some((i) => i.state === 'degraded');
  const cls = !conn.loaded ? 'checking' : bad.length ? 'red' : degraded || conn.items.some((i) => i.state === 'unknown') ? 'amber' : '';
  $('#gearDot').className = `dot ${cls}`;
  $('#gear').setAttribute('aria-label', !conn.loaded ? 'Connections: checking' : bad.length ? `Connections: ${bad.length} need attention` : degraded ? 'Connections: degraded' : 'Connections: all connected');
  $('#gear').title = $('#gear').getAttribute('aria-label');
}

function disconnectButton(item) {
  if (!item.disconnect) return '';
  return `<button class="btn danger small" data-conn-act="${item.disconnect.type}" data-label="${esc(item.label)}" data-disconnect="1">${esc(item.disconnect.label)}</button>`;
}

function actionButton(item) {
  if (!item.action) return '';
  return `<button class="btn ${item.state === 'degraded' ? 'ghost' : ''} small" data-conn-act="${item.action.type}">${esc(item.action.label || 'Fix')}</button>`;
}

async function connAction(type, el) {
  const disconnect = el && el.dataset.disconnect;
  if (type === 'claude-logout') {
    if (!confirm('Sign out of Claude Code on this computer?\n\nQA tasks will stop working until you sign in again. This also signs out Claude Code in your terminal.')) return;
    try { await api('/actions/claude-logout', { method: 'POST' }); toast('Signed out of Claude Code'); } catch (e) { toast(e.message); }
    conn.checking = true; renderConnPanel(); renderWelcome(); loadStatus(true);
    return;
  }
  if (type === 'connectors' && disconnect) {
    window.open(CONNECTORS_URL, '_blank', 'noopener');
    toast(`In the Claude tab that opened, choose Disconnect next to ${el.dataset.label}, then press Re-check.`);
    return;
  }
  if (type === 'claude-login') {
    try { await api('/actions/claude-login', { method: 'POST' }); toast('A terminal opened. Sign in there, then press Re-check.'); } catch (e) { toast(e.message); }
  } else if (type === 'connectors') {
    window.open(CONNECTORS_URL, '_blank', 'noopener');
    toast('Reconnect in the Claude tab that opened, then press Re-check.');
  } else if (type === 'install') {
    window.open('https://claude.com/claude-code', '_blank', 'noopener');
  } else if (type === 'recheck') {
    loadStatus(true);
  }
}

function connRows() {
  if (!conn.loaded) return `<div class="conn-row"><span class="led grey"></span><div><b>Checking connections…</b><span class="d">This takes a few seconds.</span></div><span></span></div>`;
  return conn.items.map((i) => `<div class="conn-row"><span class="led ${ledClass(i.state)}" aria-hidden="true"></span><div><b>${esc(i.label)}</b><span class="d">${esc(i.detail)}</span></div><div class="ra">${actionButton(i)}${disconnectButton(i)}</div></div>`).join('');
}

function renderConnPanel() {
  const el = $('#connPanel');
  if (el.hidden) return;
  el.innerHTML = `<h2>Connections</h2>${connRows()}
    <div class="conn-foot"><button class="btn ghost small" data-conn-act="recheck" ${conn.checking ? 'disabled' : ''}>${conn.checking ? 'Checking…' : 'Re-check'}</button><button class="btn ghost small" data-conn-act="welcome">Setup guide</button></div>`;
}

function toggleConnPanel(open) {
  const el = $('#connPanel');
  const want = open ?? el.hidden;
  el.hidden = !want;
  $('#gear').setAttribute('aria-expanded', String(want));
  if (want) { renderConnPanel(); loadStatus(false); }
}

$('#gear').addEventListener('click', (e) => { e.stopPropagation(); toggleConnPanel(); });
$('#connPanel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-conn-act]');
  if (!b) return;
  if (b.dataset.connAct === 'welcome') { toggleConnPanel(false); openWelcome(); } else if (b.dataset.connAct === 'recheck') { conn.checking = true; renderConnPanel(); loadStatus(true); } else connAction(b.dataset.connAct, b);
});
document.addEventListener('click', (e) => { if (!$('#connPanel').hidden && !e.target.closest('#connPanel')) toggleConnPanel(false); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#welcome').hidden) closeWelcome(); else if (!$('#connPanel').hidden) { toggleConnPanel(false); $('#gear').focus(); }
});
window.addEventListener('focus', () => { if (conn.loaded && connBad().length) loadStatus(true); }); // returning from a fix: re-check only when something was wrong

// welcome (first run)
const itemOf = (id) => conn.items.find((i) => i.id === id);
function stepHtml(n, id, title, hint, fallbackAction) {
  const it = itemOf(id);
  const st = it ? it.state : 'unknown';
  const ok = st === 'ok';
  const num = `<span class="num ${ok ? 'ok' : BAD.includes(st) ? 'bad' : ''}" aria-hidden="true">${ok ? '✓' : n}</span>`;
  const detail = it ? `${esc(it.detail)}` : conn.loaded ? '' : 'Checking…';
  const btn = ok ? disconnectButton(it) : it && it.action ? actionButton(it) : fallbackAction || '';
  return `<div class="step">${num}<div><b>${title}</b><span class="d">${detail}${detail && hint && !ok ? ' · ' : ''}${ok ? '' : hint}</span></div><div class="actions">${btn}</div></div>`;
}

function renderWelcome() {
  const el = $('#welcome');
  if (el.hidden) return;
  const allOk = conn.loaded && ['claude', 'jira', 'slack'].every((id) => itemOf(id)?.state === 'ok');
  el.innerHTML = `<div class="modal-card">
    <h2 id="welcomeTitle">Welcome to QA Agent</h2>
    <p class="lead">Connect these once so tasks can run and report. QA Agent uses your own Claude account, so nothing is shared with colleagues except what lands in Jira and Slack.</p>
    ${stepHtml(1, 'claude', 'Claude Code', 'Runs the QA tasks')}
    ${stepHtml(2, 'jira', 'Atlassian (Jira)', 'Allow access to your Jira site when asked')}
    ${stepHtml(3, 'slack', 'Slack', 'Allow access to your workspace when asked')}
    <div class="step"><span class="num" aria-hidden="true">4</span><div><b>Create your first project</b><span class="d">Pick the Jira project and Slack channel to report to. Start with a dry run.</span></div><div class="actions"><button class="btn small" data-wel="project">Create project</button></div></div>
    <div class="modal-foot">
      <button class="btn ghost small" data-wel="recheck" ${conn.checking ? 'disabled' : ''}>${conn.checking ? 'Checking…' : 'Re-check'}</button>
      <span><button class="btn ghost small" data-wel="skip">Skip for now</button> <button class="btn small" data-wel="done" ${allOk ? '' : 'disabled'}>Get started</button></span>
    </div></div>`;
}

let welcomeReturnFocus = null;
function openWelcome() {
  welcomeReturnFocus = document.activeElement;
  $('#welcome').hidden = false;
  renderWelcome();
  loadStatus(true);
  const first = $('#welcome button:not([disabled])');
  if (first) first.focus();
}
async function closeWelcome() {
  $('#welcome').hidden = true;
  try { await api('/settings', { method: 'PUT', body: { onboarded: true } }); } catch { /* non-fatal */ }
  if (welcomeReturnFocus && welcomeReturnFocus.focus) welcomeReturnFocus.focus();
}
$('#welcome').addEventListener('click', (e) => {
  const act = e.target.closest('[data-conn-act]');
  if (act) return connAction(act.dataset.connAct, act);
  const b = e.target.closest('[data-wel]');
  if (!b) return;
  if (b.dataset.wel === 'recheck') { conn.checking = true; renderWelcome(); loadStatus(true); }
  else if (b.dataset.wel === 'project') { closeWelcome(); state.id = null; state.tab = 'settings'; renderAll(); }
  else closeWelcome();
});
$('#welcome').addEventListener('keydown', (e) => { // keep Tab inside the dialog
  if (e.key !== 'Tab') return;
  const f = [...$('#welcome').querySelectorAll('button:not([disabled])')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---------- boot ----------
async function loadProjects() { state.projects = await api('/projects'); }
(async () => {
  state.env = await api('/env');
  await loadProjects();
  state.id = state.projects[0]?.id || null;
  if (!state.id) state.tab = 'settings';
  await loadTasks();
  renderAll();
  loadStatus(false);
  try { if (!(await api('/settings')).onboarded) openWelcome(); } catch { /* ignore */ }
})();
