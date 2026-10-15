// QA Agent UI server. Zero dependencies. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const os = require('os');
const updater = require('./lib/update');

const PORT = Number(process.env.PORT) || 4747;
const HOST = '127.0.0.1';
const DATA = process.env.QA_AGENT_DATA || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const ID_RE = /^[a-f0-9]{10}$/;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const IS_WIN = process.platform === 'win32';
const SKILL_DIR = path.join(__dirname, 'skill', 'qa-agent');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const SUPERVISED = process.env.QA_AGENT_SUPERVISED === '1'; // started by `qa-agent serve`, which restarts us after an update

// Apps launched from Finder / a desktop entry get a minimal PATH; make sure `claude` is findable.
if (!IS_WIN) {
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const have = (process.env.PATH || '').split(path.delimiter);
  process.env.PATH = [...extra.filter((d) => !have.includes(d)), ...have].join(path.delimiter);
}

const procs = new Map(); // taskId -> child process
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(5).toString('hex');

// ---------- storage ----------
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const projDir = (id) => path.join(DATA, 'projects', id);
const projFile = (id) => path.join(projDir(id), 'project.json');
const ctxDir = (id) => path.join(projDir(id), 'context');
const taskFile = (pid, tid) => path.join(projDir(pid), 'tasks', `${tid}.json`);
const getProject = (id) => (ID_RE.test(id) ? readJson(projFile(id), null) : null);
const getTask = (pid, tid) => (ID_RE.test(pid) && ID_RE.test(tid) ? readJson(taskFile(pid, tid), null) : null);
const saveTask = (t) => writeJson(taskFile(t.projectId, t.id), t);
const listProjects = () => {
  const dir = path.join(DATA, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => ID_RE.test(d)).map((d) => readJson(projFile(d), null)).filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
const listTasks = (pid) => {
  const dir = path.join(projDir(pid), 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
const listDocs = (pid) => (fs.existsSync(ctxDir(pid)) ? fs.readdirSync(ctxDir(pid)).map((name) => ({ name, size: fs.statSync(path.join(ctxDir(pid), name)).size })) : []);
const withDocs = (p) => ({ ...p, docs: listDocs(p.id) });

const DEFAULT_TOOLS = 'Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,ToolSearch,Bash(node:*),Bash(npx:*),Bash(python3:*),Bash(curl:*),Bash(sleep:*),Bash(mkdir:*),Bash(cd:*),Bash(ls:*),Bash(cat:*),Bash(grep:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(sort:*),Bash(uniq:*),Bash(shasum:*),Bash(md5:*),Bash(jq:*),Bash(date:*),mcp__playwright,mcp__claude_ai_Atlassian_MCP,mcp__claude_ai_Slack';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const PROJECT_FIELDS = ['name', 'folder', 'jiraProject', 'jiraBoard', 'slackChannel', 'slackAlertChannel', 'contextUrls', 'contextNotes', 'allowedTools', 'permissionMode', 'model'];

function applyProject(p, body) {
  for (const k of PROJECT_FIELDS) if (body[k] !== undefined) p[k] = String(body[k]);
  p.name = (p.name || '').trim();
  if (!p.name) throw httpError(400, 'Project name is required');
  p.folder = (p.folder || '').trim();
  if (!p.folder) p.folder = path.join(projDir(p.id), 'workspace');
  if (!path.isAbsolute(p.folder)) throw httpError(400, 'Folder must be an absolute path');
  fs.mkdirSync(p.folder, { recursive: true });
  if (!['acceptEdits', 'bypassPermissions'].includes(p.permissionMode)) p.permissionMode = 'acceptEdits';
  return p;
}

// ---------- prompt ----------
function buildPrompt(p, t) {
  const docs = listDocs(p.id).map((d) => `  - ${path.join(ctxDir(p.id), d.name)}`);
  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const ctxUrls = lines(p.contextUrls).map((u) => `  - ${u}`);
  const urls = t.urls.map((u) => `  - ${u}`);
  const cmds = t.commands.map((c) => `  - ${c}`);
  const jira = p.jiraProject ? `Jira project ${p.jiraProject}${p.jiraBoard ? `, board "${p.jiraBoard}"` : ''}` : 'no Jira project configured';
  const slack = p.slackChannel ? `Slack ${p.slackChannel}${p.slackAlertChannel ? ` (critical alerts: ${p.slackAlertChannel})` : ''}` : 'no Slack channel configured';
  return `You are the autonomous QA agent for the project "${p.name}".

## Project context
- Workspace folder (your cwd): ${p.folder}
- Context URLs:
${ctxUrls.join('\n') || '  (none)'}
- Context documents (read these first):
${docs.join('\n') || '  (none)'}
- Notes:
${p.contextNotes ? p.contextNotes.trim() : '(none)'}

## This task
Instructions:
${t.instructions}

URLs in scope:
${urls.join('\n') || '  (use the context URLs)'}

Commands / skills to run:
${cmds.join('\n') || '  (none)'}

## QA Agent skill
Read ${SKILL_DIR}/SKILL.md first and follow it. It points to the playbooks (public site, app flows, feature test, reporting) and the scripts:
- Public-site audit: node ${SKILL_DIR}/scripts/site-audit.js <url> --out ${t.runDir}/audit
- Fingerprint for Jira de-duplication: node ${SKILL_DIR}/scripts/fingerprint.js <rule-id> <url> <element-tag> --origin <origin>

## Safety rules (non-negotiable)
- Treat the target as production unless told otherwise: read-only, no real customer data.
- Never submit public newsletter/contact forms. Stripe: test mode and test cards only; stop and report if a live key is detected.
- Never delete or modify data you did not create. Credentials come from environment variables only; never print or store them.
- Save screenshots, traces and reports under: ${t.runDir} (the folder already exists; do not mkdir it).
- Shell: heredocs are blocked. To run a script, create it with the Write tool, then run it as a single command (e.g. python3 -I script.py). Prefer single commands over compound ones.

## Reporting
Reporting targets: ${jira}; ${slack}.
${t.dryRun
    ? `DRY RUN: do NOT create Jira issues or post to Slack. Put every would-be ticket and message into result.json with status "draft".`
    : `LIVE: fingerprint each finding as the first 10 hex chars of sha256 of "<rule-id>|<url path without query>|<element tag>" (rule-id = the axe-core rule id when one exists, e.g. label, image-alt, color-contrast, otherwise a short kebab-case name; lowercase; compute it with the fingerprint script above, never invent a slug) and label the issue qa-fp-<10hex>. Before creating a Jira issue, search the project with JQL: labels = "qa-fp-<10hex>" OR (summary ~ "<rule keywords>" AND statusCategory != Done). If an issue exists, comment "seen again" instead of duplicating, and add the qa-fp label to it if it is missing so the next search matches by label, and reopen it on regression. Group findings per rule per page group. Cap new tickets at 15; put the rest in one rollup ticket. Post one threaded Slack summary with links. Never include credentials or OTP codes.`}

## Connectors
Jira and Slack are MCP connectors (tools named mcp__claude_ai_Atlassian_MCP__* and mcp__claude_ai_Slack__*). They connect slowly in headless runs: load them with ToolSearch, and if a server is "still connecting" or no Jira tool is returned, run Bash "sleep 15" and retry (up to 3 times) before giving up. Jira cloudId: use getAccessibleAtlassianResources.

## Mode
${t.mode === 'unattended'
    ? 'UNATTENDED: nobody can answer questions. Make conservative choices; if blocked, record it under "blocked" in result.json and finish.'
    : 'INTERACTIVE: a human is watching. Ask when something is ambiguous, and show drafts and ask for confirmation before any Jira or Slack write.'}

## Final step (required)
Write ${path.join(t.runDir, 'result.json')} with:
{"summary": "...", "counts": {"critical":0,"serious":0,"moderate":0,"minor":0},
 "findings": [{"rule":"","severity":"","where":"","evidence":"","fix":""}],
 "jira": [{"key":"","url":"","status":"created|updated|draft"}],
 "slack": [{"channel":"","url":"","status":"posted|draft"}],
 "blocked": []}
`;
}

// ---------- runner ----------
function fmtEvent(ev) {
  if (ev.type === 'assistant') {
    return (ev.message?.content || []).map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `→ ${b.name} ${JSON.stringify(b.input).slice(0, 160)}`;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (ev.type === 'result') return `\n[${ev.subtype}] cost $${(ev.total_cost_usd || 0).toFixed(3)}`;
  return '';
}

function finish(t, status, finalText) {
  t.endedAt = now();
  t.status = status;
  t.result = readJson(path.join(t.runDir, 'result.json'), null);
  if (status === 'done' && !t.result) t.warning = 'Agent finished without writing result.json';
  const hay = `${JSON.stringify(t.result || {})} ${finalText || ''}`;
  t.links = [...new Set(hay.match(/https?:\/\/[^\s)"'\\]+/g) || [])]
    .filter((u) => /atlassian\.net|slack\.com/.test(u))
    .map((url) => ({ url, kind: /slack\.com/.test(url) ? 'slack' : 'jira' }));
  saveTask(t);
}

function runUnattended(p, t) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', p.model || DEFAULT_MODEL, '--permission-mode', p.permissionMode,
    '--add-dir', ctxDir(p.id), SKILL_DIR, '--allowed-tools', p.allowedTools || DEFAULT_TOOLS];
  const logPath = path.join(t.runDir, 'run.log');
  const log = (s) => fs.appendFileSync(logPath, s + '\n');
  // Windows resolves `claude` through claude.cmd, which needs a shell; quote args so the shell keeps them whole.
  const child = IS_WIN
    ? spawn('claude', args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`), { cwd: p.folder, env: process.env, shell: true })
    : spawn('claude', args, { cwd: p.folder, env: process.env });
  procs.set(t.id, child);
  t.pid = child.pid;
  let buf = '';
  let finalText = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'result') finalText = ev.result || '';
        const s = fmtEvent(ev);
        if (s) log(s);
      } catch { log(line); }
    }
  });
  child.stderr.on('data', (d) => log(`[stderr] ${d}`.trimEnd()));
  child.on('error', (e) => { log(`[spawn error] ${e.message}`); procs.delete(t.id); t.error = e.message; finish(t, 'failed'); });
  child.on('close', (code) => {
    procs.delete(t.id);
    const cur = getTask(t.projectId, t.id) || t;
    finish(cur, cur.status === 'cancelled' ? 'cancelled' : code === 0 ? 'done' : 'failed', finalText);
  });
  child.stdin.end(t.prompt);
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const LINUX_TERMINALS = [
  ['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']],
];
const onPath = (bin) => (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, bin)));

// Opens a terminal window running a script. `sh` is used on macOS/Linux, `ps` (PowerShell) on Windows.
function launchTerminal(dir, { sh, ps }, onError) {
  fs.mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    const ps1 = path.join(dir, 'launch.ps1');
    fs.writeFileSync(ps1, ps);
    spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ps1], { detached: true, stdio: 'ignore' }).on('error', onError).unref();
    return;
  }
  const file = path.join(dir, 'launch.sh');
  fs.writeFileSync(file, sh, { mode: 0o755 });
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script "bash ${shq(file).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    execFile('osascript', ['-e', script], onError);
  } else {
    const term = LINUX_TERMINALS.find(([bin]) => onPath(bin));
    if (!term) throw httpError(400, 'No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, xterm)');
    spawn(term[0], [...term[1], 'bash', file], { detached: true, stdio: 'ignore' }).on('error', onError).unref();
  }
}

const shHead = (cwd) => `#!/bin/bash\nexport PATH=${shq(process.env.PATH)}\ncd ${shq(cwd)} || exit 1\n`;
const shTail = '\nexec "${SHELL:-/bin/bash}"\n';

// Opens `claude` with the task prompt in a terminal. The agent writes result.json when done.
// The prompt goes first: --add-dir takes multiple values and would swallow a trailing prompt.
function runInteractive(p, t) {
  const promptFile = path.join(t.runDir, 'prompt.md');
  const fail = (err) => { if (err) { t.error = err.message; finish(t, 'failed'); } };
  launchTerminal(t.runDir, {
    sh: `${shHead(p.folder)}claude "$(cat ${shq(promptFile)})" --permission-mode default --add-dir ${shq(ctxDir(p.id))} --add-dir ${shq(SKILL_DIR)}${shTail}`,
    ps: `Set-Location -LiteralPath ${psq(p.folder)}\nclaude (Get-Content -Raw -LiteralPath ${psq(promptFile)}) --permission-mode default --add-dir ${psq(ctxDir(p.id))} --add-dir ${psq(SKILL_DIR)}\n`,
  }, fail);
  t.status = 'interactive';
}

// ---------- connection status ----------
const readSettings = () => ({ onboarded: false, ...readJson(SETTINGS_FILE, {}) });
let statusCache = { at: 0, items: [], checking: false };

const run = (bin, args, ms) => new Promise((resolve) => {
  execFile(bin, args, { timeout: ms, env: process.env, shell: IS_WIN, maxBuffer: 4e6 }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
});

// `claude mcp list` prints "<name>: <target> - <mark> <text>" per server
function parseMcpList(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?):\s+(.*?)\s+-\s+([\u2714\u2718!])\s*(.*)$/);
    if (m) rows.push({ name: m[1].trim(), mark: m[3], text: m[4].trim() });
  }
  return rows;
}

const CONNECTORS = [
  { id: 'jira', label: 'Atlassian (Jira)', re: /atlassian|jira/i },
  { id: 'slack', label: 'Slack', re: /slack/i },
];

function connectorItem(def, rows) {
  const row = rows.find((r) => def.re.test(r.name));
  const fix = { type: 'connectors', label: 'Reconnect' };
  if (!row) return { id: def.id, label: def.label, state: 'missing', detail: 'Not connected to your Claude account', action: { type: 'connectors', label: 'Connect' } };
  const disconnect = { type: 'connectors', label: 'Disconnect' };
  if (row.mark === '\u2714') return { id: def.id, label: def.label, state: 'ok', detail: 'Connected', disconnect };
  if (/needs auth/i.test(row.text)) return { id: def.id, label: def.label, state: 'needs-auth', detail: 'Needs authentication', action: fix };
  if (row.mark === '!') return { id: def.id, label: def.label, state: 'degraded', detail: row.text || 'Connected, but tools did not load', disconnect };
  return { id: def.id, label: def.label, state: 'failed', detail: row.text || 'Failed to connect', action: fix };
}

async function refreshStatus() {
  if (statusCache.checking) return;
  statusCache = { ...statusCache, checking: true };
  const items = [];
  try {
    const v = await run('claude', ['--version'], 10000);
    if (v.err) {
      items.push({ id: 'claude', label: 'Claude Code', state: 'missing', detail: 'The claude command was not found', action: { type: 'install', label: 'Install guide' } });
    } else {
      const a = await run('claude', ['auth', 'status'], 15000);
      let info = null;
      try { info = JSON.parse(a.stdout); } catch { /* not signed in */ }
      const ver = v.stdout.trim().split(/\s+/)[0];
      if (info && info.loggedIn) {
        items.push({ id: 'claude', label: 'Claude Code', state: 'ok', detail: `Signed in${info.email ? ` as ${info.email}` : ''}${ver ? ` · v${ver}` : ''}`, disconnect: { type: 'claude-logout', label: 'Sign out' } });
        const m = await run('claude', ['mcp', 'list'], 120000);
        const rows = parseMcpList(m.stdout);
        for (const def of CONNECTORS) items.push(connectorItem(def, rows));
      } else {
        items.push({ id: 'claude', label: 'Claude Code', state: 'needs-auth', detail: 'Not signed in', action: { type: 'claude-login', label: 'Sign in' } });
        for (const def of CONNECTORS) items.push({ id: def.id, label: def.label, state: 'unknown', detail: 'Sign in to Claude first' });
      }
    }
  } catch (e) {
    items.push({ id: 'claude', label: 'Claude Code', state: 'unknown', detail: e.message });
  }
  statusCache = { at: Date.now(), items, checking: false };
}

// interactive tasks complete when the agent writes result.json
setInterval(() => {
  for (const p of listProjects()) {
    for (const t of listTasks(p.id)) {
      if (t.status === 'interactive' && fs.existsSync(path.join(t.runDir, 'result.json'))) finish(t, 'done');
    }
  }
}, 3000);

// A restart orphans the child but does not kill it: reconcile from result.json / pid liveness.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const p of listProjects()) {
  for (const t of listTasks(p.id)) {
    const orphaned = t.status === 'running' || t.error === 'Server restarted while running';
    if (!orphaned) continue;
    const hasResult = fs.existsSync(path.join(t.runDir, 'result.json'));
    delete t.error;
    if (t.status === 'running' && !hasResult && t.pid && alive(t.pid)) {
      const timer = setInterval(() => { if (!alive(t.pid)) { clearInterval(timer); finish(t, 'done'); } }, 3000);
    } else {
      if (!hasResult) t.error = 'Server restarted before the task finished';
      finish(t, hasResult ? 'done' : 'failed');
    }
  }
}

// ---------- updates ----------
let updateState = { current: updater.CURRENT, latest: null, tag: null, available: false, url: null, notes: '', checkedAt: 0, error: null, applying: false };
const runningTasks = () => listProjects().flatMap((p) => listTasks(p.id)).filter((t) => t.status === 'running' || t.status === 'interactive').length;

async function applyUpdate() {
  if (updateState.applying) throw httpError(409, 'An update is already in progress');
  const n = runningTasks();
  if (n) throw httpError(409, `${n} task${n === 1 ? ' is' : 's are'} still running. Wait for ${n === 1 ? 'it' : 'them'} to finish, then update.`);
  updateState.applying = true;
  try {
    const r = await updater.apply(updateState.tag);
    if (SUPERVISED) setTimeout(() => process.exit(75), 500); // exit code 75 = "restart me" for the supervisor
    return { ...r, restarting: SUPERVISED };
  } catch (e) {
    updateState.applying = false;
    throw httpError(e.status || 500, e.message);
  }
}

async function checkForUpdate() {
  try { updateState = { ...updateState, ...(await updater.checkLatest()), checkedAt: Date.now(), error: null }; }
  catch (e) { updateState = { ...updateState, checkedAt: Date.now(), error: e.message }; }
  if (updateState.available && readSettings().autoUpdate && !updateState.applying && runningTasks() === 0) {
    try { await applyUpdate(); } catch { /* the UI shows the reason the next time it is opened */ }
  }
  return updateState;
}

function startTask(p, body) {
  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const instructions = String(body.instructions || '').trim();
  if (!instructions) throw httpError(400, 'Instructions are required');
  const mode = body.mode === 'unattended' ? 'unattended' : 'interactive';
  const dryRun = body.dryRun !== false;
  if (!dryRun && (!p.jiraProject || !p.slackChannel)) throw httpError(400, 'Set Jira project and Slack channel in Settings, or enable dry run');
  if (!fs.existsSync(p.folder)) throw httpError(400, `Folder not found: ${p.folder}`);
  const id = newId();
  const t = {
    id, projectId: p.id, createdAt: now(), startedAt: now(), status: 'running', mode, dryRun,
    instructions, urls: lines(body.urls), commands: lines(body.commands),
    runDir: path.join(p.folder, 'qa-runs', id),
  };
  fs.mkdirSync(t.runDir, { recursive: true });
  t.prompt = buildPrompt(p, t);
  fs.writeFileSync(path.join(t.runDir, 'prompt.md'), t.prompt);
  saveTask(t);
  try {
    if (mode === 'unattended') runUnattended(p, t); else runInteractive(p, t);
  } catch (e) { t.error = e.message; finish(t, 'failed'); throw e; }
  saveTask(t);
  return t;
}

// ---------- http ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 25e6) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
});

// Reject cross-site requests: this server can spawn processes on the user's machine.
function sameOrigin(req) {
  const ok = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!ok.includes(req.headers.host)) return false;
  return !req.headers.origin || ok.some((h) => req.headers.origin === `http://${h}`);
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const m = req.method;
  if (parts[0] === 'env' && m === 'GET') return send(res, 200, { platform: process.platform, defaultTools: DEFAULT_TOOLS, defaultModel: DEFAULT_MODEL });
  if (parts[0] === 'status' && m === 'GET') {
    if (url.searchParams.get('refresh') === '1' || (!statusCache.checking && Date.now() - statusCache.at > 300000)) refreshStatus();
    return send(res, 200, statusCache);
  }
  if (parts[0] === 'settings') {
    if (m === 'GET') return send(res, 200, readSettings());
    if (m === 'PUT') {
      const body = await readBody(req);
      const next = readSettings();
      if (typeof body.onboarded === 'boolean') next.onboarded = body.onboarded;
      if (typeof body.autoUpdate === 'boolean') next.autoUpdate = body.autoUpdate;
      writeJson(SETTINGS_FILE, next);
      return send(res, 200, next);
    }
  }
  if (parts[0] === 'update' && !parts[1] && m === 'GET') {
    if (url.searchParams.get('refresh') === '1' || Date.now() - updateState.checkedAt > 6 * 3600e3) await checkForUpdate();
    return send(res, 200, {
      ...updateState, readiness: await updater.readiness(), commands: updater.commandsFor(updateState.tag),
      slug: updater.SLUG, platform: process.platform, supervised: SUPERVISED, autoUpdate: Boolean(readSettings().autoUpdate), runningTasks: runningTasks(),
    });
  }
  if (parts[0] === 'update' && parts[1] === 'apply' && m === 'POST') return send(res, 200, { ok: true, ...(await applyUpdate()) });
  if (parts[0] === 'shutdown' && m === 'POST') {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 150); // let the response flush; running tasks keep going and are reconciled on the next start
    return;
  }
  if (parts[0] === 'actions' && parts[1] === 'claude-login' && m === 'POST') {
    launchTerminal(path.join(DATA, 'actions'), {
      sh: `${shHead(os.homedir())}claude auth login\necho\necho "Done. Go back to QA Agent and press Re-check."${shTail}`,
      ps: 'claude auth login\nWrite-Host ""\nWrite-Host "Done. Go back to QA Agent and press Re-check."\n',
    }, () => {});
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'actions' && parts[1] === 'claude-logout' && m === 'POST') {
    const r = await run('claude', ['auth', 'logout'], 20000);
    if (r.err) throw httpError(500, `Sign out failed: ${r.err.message}`);
    statusCache = { at: 0, items: [], checking: false };
    refreshStatus();
    return send(res, 200, { ok: true });
  }
  if (parts[0] !== 'projects') throw httpError(404, 'Not found');

  if (parts.length === 1) {
    if (m === 'GET') return send(res, 200, listProjects().map(withDocs));
    if (m === 'POST') {
      const p = applyProject({ id: newId(), createdAt: now(), allowedTools: DEFAULT_TOOLS, permissionMode: 'acceptEdits', model: DEFAULT_MODEL }, await readBody(req));
      writeJson(projFile(p.id), p);
      return send(res, 201, withDocs(p));
    }
  }
  const p = getProject(parts[1]);
  if (!p) throw httpError(404, 'Project not found');
  const sub = parts[2];

  if (!sub) {
    if (m === 'GET') return send(res, 200, withDocs(p));
    if (m === 'PUT') { applyProject(p, await readBody(req)); writeJson(projFile(p.id), p); return send(res, 200, withDocs(p)); }
    if (m === 'DELETE') { fs.rmSync(projDir(p.id), { recursive: true, force: true }); return send(res, 200, { ok: true }); }
  }
  if (sub === 'docs') {
    if (m === 'POST') {
      const { name, data } = await readBody(req);
      const safe = path.basename(String(name || '')).replace(/[^\w.\- ]/g, '_');
      if (!safe || !data) throw httpError(400, 'name and data required');
      fs.mkdirSync(ctxDir(p.id), { recursive: true });
      fs.writeFileSync(path.join(ctxDir(p.id), safe), Buffer.from(data, 'base64'));
      return send(res, 201, listDocs(p.id));
    }
    if (m === 'DELETE' && parts[3]) {
      fs.rmSync(path.join(ctxDir(p.id), path.basename(decodeURIComponent(parts[3]))), { force: true });
      return send(res, 200, listDocs(p.id));
    }
  }
  if (sub === 'tasks') {
    if (!parts[3]) {
      if (m === 'GET') return send(res, 200, listTasks(p.id).map(({ prompt, ...t }) => t));
      if (m === 'POST') { const { prompt, ...t } = startTask(p, await readBody(req)); return send(res, 201, t); }
    } else {
      const t = getTask(p.id, parts[3]);
      if (!t) throw httpError(404, 'Task not found');
      const action = parts[4];
      if (!action && m === 'GET') {
        const log = (() => { try { return fs.readFileSync(path.join(t.runDir, 'run.log'), 'utf8').slice(-20000); } catch { return ''; } })();
        return send(res, 200, { ...t, log });
      }
      if (action === 'cancel' && m === 'POST') {
        t.status = 'cancelled'; saveTask(t);
        const c = procs.get(t.id);
        if (c) c.kill('SIGTERM'); else finish(t, 'cancelled');
        return send(res, 200, { ok: true });
      }
      if (action === 'complete' && m === 'POST') { finish(t, 'done'); return send(res, 200, { ok: true }); }
    }
  }
  throw httpError(404, 'Not found');
}

http.createServer(async (req, res) => {
  try {
    if (!sameOrigin(req)) throw httpError(403, 'Forbidden origin');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUB, path.normalize(rel));
    if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file)) throw httpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, HOST, () => { console.log(`QA Agent UI: http://localhost:${PORT}`); refreshStatus(); checkForUpdate(); setInterval(checkForUpdate, 6 * 3600e3); });
