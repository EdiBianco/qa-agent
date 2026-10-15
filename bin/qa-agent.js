#!/usr/bin/env node
// QA Agent launcher CLI. No dependencies.
//   qa-agent serve [--open] [--parent <pid>]   start the server (if not running) and optionally open the browser;
//                              with --parent, stop the server when that process disappears (used by the launchers)
//   qa-agent stop              ask the running server to shut down
//   qa-agent update [--check]  check GitHub for a newer release and update this checkout in place
//   qa-agent install           add a launcher with an icon (macOS Dock / Windows tray / Linux desktop)
//   qa-agent uninstall         remove it
//   qa-agent install-skill     copy the qa-agent skill to ~/.claude/skills so any Claude Code session can use it
//   qa-agent uninstall-skill   remove it
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 4747;
const URL_ = `http://localhost:${PORT}`;
const DATA = process.env.QA_AGENT_DATA || path.join(ROOT, 'data');
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/env', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  const [bin, a] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawn(bin, a, { detached: true, stdio: 'ignore' }).on('error', () => console.log(`Open ${url} in your browser`)).unref();
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Asks whichever server is on PORT to exit (works for servers this process did not start).
function shutdownServer() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/shutdown', method: 'POST', timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function serve() {
  const parent = Number(opt('parent')) || 0;
  let child = null;
  if (await probe()) {
    console.log(`QA Agent already running at ${URL_}`);
    if (flag('open')) openBrowser(URL_);
    if (!parent) return;
  } else {
    fs.mkdirSync(DATA, { recursive: true });
    const out = fs.openSync(path.join(DATA, 'server.log'), 'a');
    let stopping = false;
    // The server exits with code 75 after applying an update; restart it so the new code is running.
    const launch = () => {
      child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', out, out], env: { ...process.env, QA_AGENT_SUPERVISED: '1' } });
      child.on('exit', (code) => { if (code === 75 && !stopping) setTimeout(launch, 300); else process.exit(code ?? 0); });
    };
    launch();
    const stop = () => { stopping = true; child.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGHUP', stop);
    for (let i = 0; i < 50 && !(await probe()); i++) await new Promise((r) => setTimeout(r, 200));
    console.log(`QA Agent running at ${URL_} (log: ${path.join(DATA, 'server.log')})`);
    if (flag('open')) openBrowser(URL_);
  }
  // Launcher mode: when the launcher process is gone (quit, crash, force quit), take the server down with it,
  // whether this process started it or adopted one that was already running.
  if (parent) {
    setInterval(async () => {
      if (alive(parent)) return;
      await shutdownServer();
      if (child) child.kill('SIGTERM');
      setTimeout(() => process.exit(0), 300);
    }, 2000);
  }
}

// ---------- install ----------
const A = (f) => path.join(ROOT, 'assets', f);

const MAC_SYSTEM_APPS = '/Applications';
const MAC_USER_APPS = path.join(os.homedir(), 'Applications');
const macAppAt = (dir) => path.join(dir, 'QA Agent.app');
// /Applications (all users) when this account can write there (admin accounts can), else ~/Applications.
function macTargetDir() {
  if (opt('dir')) return opt('dir');
  try { fs.accessSync(MAC_SYSTEM_APPS, fs.constants.W_OK); return MAC_SYSTEM_APPS; } catch { return MAC_USER_APPS; }
}
function macApp() { return macAppAt(macTargetDir()); }
function linuxPaths() {
  const share = path.join(os.homedir(), '.local', 'share');
  return { desktop: path.join(share, 'applications', 'qa-agent.desktop'), icon: path.join(share, 'icons', 'hicolor', '256x256', 'apps', 'qa-agent.png'), onDesktop: path.join(os.homedir(), 'Desktop', 'QA Agent.desktop') };
}

function install() {
  const node = process.execPath;
  if (process.platform === 'darwin') {
    const app = macApp();
    if (!opt('dir')) { // drop a copy from the other default location so there is only one icon
      for (const dir of [MAC_SYSTEM_APPS, MAC_USER_APPS]) {
        const other = macAppAt(dir);
        if (other !== app && fs.existsSync(other)) { try { fs.rmSync(other, { recursive: true, force: true }); console.log(`Removed older copy ${other}`); } catch { console.log(`Could not remove ${other}; delete it manually`); } }
      }
    }
    const res = path.join(app, 'Contents', 'Resources');
    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(res, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'launchers', 'mac', 'qa-agent.sh'), path.join(app, 'Contents', 'MacOS', 'qa-agent'));
    fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'qa-agent'), 0o755);
    fs.copyFileSync(path.join(ROOT, 'launchers', 'mac', 'dock.js'), path.join(res, 'dock.js'));
    fs.copyFileSync(A('AppIcon.icns'), path.join(res, 'AppIcon.icns'));
    fs.writeFileSync(path.join(res, 'repo_path'), ROOT);
    fs.writeFileSync(path.join(res, 'node_path'), node);
    fs.writeFileSync(path.join(res, 'port'), String(PORT));
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>QA Agent</string>
<key>CFBundleDisplayName</key><string>QA Agent</string>
<key>CFBundleIdentifier</key><string>local.qa-agent.launcher</string>
<key>CFBundleExecutable</key><string>qa-agent</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`);
    console.log(`Installed ${app}\nOpen it from Launchpad, Spotlight or the Applications folder. The icon appears in the Dock; right-click it and choose Quit (or press Cmd-Q) to stop the server.${app.startsWith(MAC_USER_APPS) && !opt('dir') ? `\n(/Applications is not writable for this account, so it was installed for your user only. Use an administrator account to install it for everyone.)` : ''}`);
  } else if (process.platform === 'win32') {
    const script = `
$ws = New-Object -ComObject WScript.Shell
$targets = @([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'QA Agent.lnk'), [IO.Path]::Combine([Environment]::GetFolderPath('Programs'),'QA Agent.lnk'))
foreach ($t in $targets) {
  $s = $ws.CreateShortcut($t)
  $s.TargetPath = 'powershell.exe'
  $s.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(ROOT, 'launchers', 'windows', 'tray.ps1')}" -Repo "${ROOT}" -Node "${node}" -Icon "${A('icon.ico')}" -Port ${PORT}'
  $s.IconLocation = '${A('icon.ico')}'
  $s.WorkingDirectory = '${ROOT}'
  $s.Description = 'QA Agent'
  $s.Save()
}`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
    console.log('Created "QA Agent" shortcuts on the Desktop and in the Start menu.\nRight-click either one and choose "Pin to taskbar" to keep it on the bottom bar. Quit from the tray icon stops the server.');
  } else {
    const p = linuxPaths();
    fs.mkdirSync(path.dirname(p.desktop), { recursive: true });
    fs.mkdirSync(path.dirname(p.icon), { recursive: true });
    fs.copyFileSync(A('icon-256.png'), p.icon);
    const entry = `[Desktop Entry]
Type=Application
Name=QA Agent
Comment=Autonomous QA testing
Exec=env QA_NODE="${node}" PORT=${PORT} /bin/bash "${path.join(ROOT, 'launchers', 'linux', 'qa-agent.sh')}"
Icon=${p.icon}
Terminal=false
Categories=Development;Utility;
StartupNotify=false
`;
    fs.writeFileSync(p.desktop, entry, { mode: 0o755 });
    if (fs.existsSync(path.dirname(p.onDesktop))) {
      fs.writeFileSync(p.onDesktop, entry, { mode: 0o755 });
      try { execFileSync('gio', ['set', p.onDesktop, 'metadata::trusted', 'true']); } catch { /* optional */ }
    }
    try { execFileSync('update-desktop-database', [path.dirname(p.desktop)]); } catch { /* optional */ }
    console.log(`Installed ${p.desktop}${fs.existsSync(p.onDesktop) ? ` and ${p.onDesktop}` : ''}\nFind "QA Agent" in your app menu. Closing its window (or Quit in the tray) stops the server.`);
  }
}

function uninstall() {
  if (process.platform === 'darwin') {
    const dirs = opt('dir') ? [opt('dir')] : [MAC_SYSTEM_APPS, MAC_USER_APPS];
    for (const dir of dirs) { const app = macAppAt(dir); if (fs.existsSync(app)) { fs.rmSync(app, { recursive: true, force: true }); console.log(`Removed ${app}`); } }
  }
  else if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Remove-Item -ErrorAction SilentlyContinue ([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'QA Agent.lnk')), ([IO.Path]::Combine([Environment]::GetFolderPath('Programs'),'QA Agent.lnk'))`], { stdio: 'inherit' });
    console.log('Removed QA Agent shortcuts');
  } else {
    const p = linuxPaths();
    for (const f of [p.desktop, p.icon, p.onDesktop]) fs.rmSync(f, { force: true });
    console.log('Removed QA Agent launcher');
  }
}

const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', 'qa-agent');
function installSkill() {
  fs.rmSync(SKILL_DEST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(SKILL_DEST), { recursive: true });
  fs.cpSync(path.join(ROOT, 'skill', 'qa-agent'), SKILL_DEST, { recursive: true });
  console.log(`Installed skill to ${SKILL_DEST}\nStart a new Claude Code session and ask it to run QA, or use /qa-agent.`);
}

async function updateCmd() {
  const u = require('../lib/update');
  let r;
  try { r = await u.checkLatest(); } catch (e) { return console.log(`Could not check for updates: ${e.message}`); }
  console.log(`Installed: v${u.CURRENT}\nLatest:    ${r.tag || '(no release published)'}`);
  if (!r.available) return console.log('You are up to date.');
  if (flag('check')) return console.log(`Update available: ${r.url}\nRun: node bin/qa-agent.js update`);
  const ready = await u.readiness();
  if (!ready.ok) {
    const c = u.commandsFor(r.tag);
    return console.log(`Cannot update in place: ${ready.reason}\n\nRun this in ${c.shell}:\n  ${c.git}\n\nNo git? Use:\n  ${c.tarball}`);
  }
  const res = await u.apply(r.tag);
  console.log(`Updated v${u.CURRENT} -> v${res.version}.`);
  if (res.skillRefreshed) console.log('Refreshed the skill in ~/.claude/skills/qa-agent.');
  if (res.launcherChanged) console.log('The launcher changed in this release: run  node bin/qa-agent.js install  again.');
  console.log('Restart QA Agent to use the new version.');
}

(async () => {
  if (cmd === 'install-skill') return installSkill();
  if (cmd === 'uninstall-skill') { fs.rmSync(SKILL_DEST, { recursive: true, force: true }); return console.log(`Removed ${SKILL_DEST}`); }
  if (cmd === 'update') await updateCmd();
  else if (cmd === 'stop') console.log((await shutdownServer()) ? `Stopped the server on port ${PORT}` : `No server running on port ${PORT}`);
  else if (cmd === 'serve' || cmd === 'start') await serve();
  else if (cmd === 'install') install();
  else if (cmd === 'uninstall') uninstall();
  else console.log('Usage: qa-agent <serve [--open] | stop | update [--check] | install [--dir <folder, macOS>] | uninstall | install-skill | uninstall-skill>');
})().catch((e) => { console.error(e.message); process.exit(1); });
