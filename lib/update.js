// Update checks and in-place updates from GitHub releases. Zero dependencies (Node 18+).
// Shared by server.js (UI) and bin/qa-agent.js (CLI).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CURRENT = pkg.version;
// "owner/repo" from package.json "repository" (so forks can point at themselves)
const SLUG = String((pkg.repository && pkg.repository.url) || pkg.repository || '')
  .replace(/^github:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') || 'EdiBianco/qa-agent';
const API = process.env.QA_AGENT_API || 'https://api.github.com'; // override for tests or GitHub Enterprise
const TEST_MODE = Boolean(process.env.QA_AGENT_API);
const SKILL_SRC = path.join(ROOT, 'skill', 'qa-agent');
const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', 'qa-agent');

const parts = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

const git = (args, ms = 60000) => new Promise((resolve) => {
  execFile('git', ['-C', ROOT, ...args], { timeout: ms, maxBuffer: 4e6, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
});

// Latest published (non-draft, non-prerelease) release from GitHub.
async function checkLatest() {
  const res = await fetch(`${API}/repos/${SLUG}/releases/latest`, {
    headers: { 'User-Agent': 'qa-agent-updater', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { tag: null, latest: null, available: false };
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const j = await res.json();
  return {
    tag: j.tag_name,
    latest: String(j.tag_name).replace(/^v/, ''),
    available: isNewer(j.tag_name, CURRENT),
    url: j.html_url,
    notes: String(j.body || '').slice(0, 2000),
    publishedAt: j.published_at,
  };
}

// Can we update in place? Needs a git checkout of this repo with no local changes.
async function readiness() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { ok: false, reason: 'This copy was not installed with git (there is no .git folder).' };
  if (!(await git(['--version'])).ok) return { ok: false, reason: 'git is not installed.' };
  const remote = await git(['remote', 'get-url', 'origin']);
  if (!remote.ok) return { ok: false, reason: 'This checkout has no "origin" remote.' };
  if (!TEST_MODE && !remote.out.toLowerCase().includes(SLUG.toLowerCase())) return { ok: false, reason: `The "origin" remote (${remote.out.trim()}) is not ${SLUG}.` };
  const st = await git(['status', '--porcelain']);
  if (!st.ok) return { ok: false, reason: 'Could not read the git status.' };
  if (st.out.trim()) return { ok: false, reason: 'There are local changes in the install folder.' };
  return { ok: true };
}

// The commands a person would run for their OS.
function commandsFor(tag, platform = process.platform) {
  const t = tag || '<tag>';
  const win = platform === 'win32';
  const url = `https://github.com/${SLUG}/archive/refs/tags/${t}.tar.gz`;
  return win
    ? {
      shell: 'PowerShell',
      git: `cd "${ROOT}"; git fetch --tags --force; git merge --ff-only ${t}`,
      tarball: `cd "${ROOT}"; curl.exe -fsSL -o qa-agent-update.tgz ${url}; tar -xzf qa-agent-update.tgz --strip-components=1; Remove-Item qa-agent-update.tgz`,
    }
    : {
      shell: platform === 'darwin' ? 'Terminal' : 'a terminal',
      git: `cd "${ROOT}" && git fetch --tags --force && git merge --ff-only ${t}`,
      tarball: `cd "${ROOT}" && curl -fsSL ${url} | tar -xz --strip-components=1`,
    };
}

// Re-copy the skill if it was installed into ~/.claude/skills.
function refreshSkill() {
  if (!fs.existsSync(SKILL_DEST)) return false;
  fs.rmSync(SKILL_DEST, { recursive: true, force: true });
  fs.cpSync(SKILL_SRC, SKILL_DEST, { recursive: true });
  return true;
}

// Fetch the release tag and fast-forward to it. Never discards local work.
async function apply(tag) {
  if (!tag) throw Object.assign(new Error('No release to update to.'), { status: 400 });
  const ready = await readiness();
  if (!ready.ok) throw Object.assign(new Error(ready.reason), { status: 400 });
  const from = (await git(['rev-parse', '--short', 'HEAD'])).out.trim();
  const fetched = await git(['fetch', 'origin', '--tags', '--force'], 120000);
  if (!fetched.ok) throw Object.assign(new Error(`git fetch failed: ${fetched.err.trim().split('\n').pop()}`), { status: 502 });
  if (!(await git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])).ok) throw Object.assign(new Error(`Tag ${tag} was not found after fetching.`), { status: 502 });
  const changed = (await git(['diff', '--name-only', 'HEAD', tag])).out.split('\n').filter(Boolean);
  const merged = await git(['merge', '--ff-only', tag]);
  if (!merged.ok) throw Object.assign(new Error('Could not fast-forward (this copy has diverged from the release). Run the command shown instead.'), { status: 409 });
  const to = (await git(['rev-parse', '--short', 'HEAD'])).out.trim();
  const newPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return {
    from, to, version: newPkg.version,
    // the macOS app and Windows/Linux launchers keep their own copies of these
    launcherChanged: changed.some((f) => /^(launchers\/|assets\/AppIcon)/.test(f)),
    skillRefreshed: refreshSkill(),
  };
}

module.exports = { ROOT, SLUG, CURRENT, TEST_MODE, isNewer, checkLatest, readiness, commandsFor, apply };
