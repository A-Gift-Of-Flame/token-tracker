'use strict';

// One command to make `tt watch` always-on across reboots/crashes, on every OS.
// The watch loop is the portable core (see watch.js); the only per-OS difference
// is the boot supervisor. This module hides that difference behind
// `tt service install|uninstall|status` so a user never hand-writes a systemd
// unit / launchd plist / scheduled task.
//
// Design rules:
//   - Use the running Node binary (process.execPath) and the on-disk tt.js so the
//     installed service runs the same code the user just invoked.
//   - Preserve TOKEN_TRACKER_DIR if the user overrode the data dir.
//   - Idempotent: re-running install overwrites the unit and restarts cleanly.
//   - Never throw raw — return { ok, message } so the CLI prints one clear line.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'token-tracker';
const TT_JS = path.resolve(__dirname, '..', 'bin', 'tt.js');
const NODE = process.execPath;

function ttEnv() {
    // Only forward an explicit data-dir override; default resolves the same way
    // in the service as it does here.
    return process.env.TOKEN_TRACKER_DIR
        ? { TOKEN_TRACKER_DIR: process.env.TOKEN_TRACKER_DIR }
        : {};
}

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function tryRun(cmd, args, opts = {}) {
    try {
        return { ok: true, out: run(cmd, args, opts) };
    } catch (err) {
        return { ok: false, out: (err.stdout || '') + (err.stderr || '') || err.message };
    }
}

// ---------- Linux: systemd user unit ----------

const SYSTEMD_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const SYSTEMD_UNIT = path.join(SYSTEMD_DIR, LABEL + '.service');

function systemdUnitText(interval) {
    const env = ttEnv();
    const envLines = Object.entries(env).map(([k, v]) => 'Environment=' + k + '=' + v).join('\n');
    return [
        '[Unit]',
        'Description=token-tracker continuous sync+push',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=' + NODE + ' ' + TT_JS + ' watch --interval ' + interval,
        envLines,
        'Restart=always',
        'RestartSec=10',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].filter((l) => l !== '').join('\n') + '\n';
}

function installSystemd(interval) {
    fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
    fs.writeFileSync(SYSTEMD_UNIT, systemdUnitText(interval));
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', LABEL + '.service']);
    // Linger lets the service run without an active login session (after reboot,
    // before the user logs in). Best-effort: may need polkit; warn if it fails.
    const linger = tryRun('loginctl', ['enable-linger', os.userInfo().username]);
    let msg = 'installed systemd user service (' + SYSTEMD_UNIT + ') — running now, starts on boot.';
    if (!linger.ok) msg += '\nnote: could not enable-linger (service may pause when logged out). run: sudo loginctl enable-linger ' + os.userInfo().username;
    return { ok: true, message: msg };
}

function uninstallSystemd() {
    tryRun('systemctl', ['--user', 'disable', '--now', LABEL + '.service']);
    try { fs.unlinkSync(SYSTEMD_UNIT); } catch {}
    tryRun('systemctl', ['--user', 'daemon-reload']);
    return { ok: true, message: 'removed systemd user service.' };
}

function statusSystemd() {
    const active = tryRun('systemctl', ['--user', 'is-active', LABEL + '.service']);
    const enabled = tryRun('systemctl', ['--user', 'is-enabled', LABEL + '.service']);
    return {
        ok: true,
        message: 'service: ' + active.out.trim() + ' / ' + enabled.out.trim()
            + (fs.existsSync(SYSTEMD_UNIT) ? '' : ' (not installed)'),
    };
}

// ---------- macOS: launchd LaunchAgent ----------

const PLIST_LABEL = 'com.token-tracker.watch';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_LABEL + '.plist');

function plistText(interval) {
    const env = ttEnv();
    const envDict = Object.keys(env).length
        ? '  <key>EnvironmentVariables</key>\n  <dict>\n'
          + Object.entries(env).map(([k, v]) => '    <key>' + k + '</key><string>' + v + '</string>').join('\n')
          + '\n  </dict>\n'
        : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        + '<plist version="1.0">\n<dict>\n'
        + '  <key>Label</key><string>' + PLIST_LABEL + '</string>\n'
        + '  <key>ProgramArguments</key>\n  <array>\n'
        + '    <string>' + NODE + '</string>\n'
        + '    <string>' + TT_JS + '</string>\n'
        + '    <string>watch</string>\n'
        + '    <string>--interval</string>\n'
        + '    <string>' + interval + '</string>\n'
        + '  </array>\n'
        + envDict
        + '  <key>RunAtLoad</key><true/>\n'
        + '  <key>KeepAlive</key><true/>\n'
        + '</dict>\n</plist>\n';
}

function installLaunchd(interval) {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, plistText(interval));
    const uid = process.getuid();
    // bootout first so re-install reloads cleanly; ignore if not loaded.
    tryRun('launchctl', ['bootout', 'gui/' + uid + '/' + PLIST_LABEL]);
    const boot = tryRun('launchctl', ['bootstrap', 'gui/' + uid, PLIST_PATH]);
    if (!boot.ok) {
        // Older macOS fallback.
        tryRun('launchctl', ['load', '-w', PLIST_PATH]);
    }
    tryRun('launchctl', ['kickstart', 'gui/' + uid + '/' + PLIST_LABEL]);
    return { ok: true, message: 'installed launchd agent (' + PLIST_PATH + ') — running now, starts on login.' };
}

function uninstallLaunchd() {
    const uid = process.getuid();
    tryRun('launchctl', ['bootout', 'gui/' + uid + '/' + PLIST_LABEL]);
    tryRun('launchctl', ['unload', '-w', PLIST_PATH]);
    try { fs.unlinkSync(PLIST_PATH); } catch {}
    return { ok: true, message: 'removed launchd agent.' };
}

function statusLaunchd() {
    const r = tryRun('launchctl', ['list', PLIST_LABEL]);
    return { ok: true, message: r.ok ? 'service loaded.' : 'service not loaded.' };
}

// ---------- Windows: Scheduled Task ----------

const TASK_NAME = 'token-tracker-watch';

function installSchtasks(interval) {
    // ONLOGON task that runs the watch loop. /f overwrites on re-install.
    const tr = '"' + NODE + '" "' + TT_JS + '" watch --interval ' + interval;
    const r = tryRun('schtasks', ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'onlogon', '/rl', 'limited', '/f']);
    if (!r.ok) return { ok: false, message: 'schtasks create failed: ' + r.out.trim() };
    tryRun('schtasks', ['/run', '/tn', TASK_NAME]);
    return { ok: true, message: 'installed scheduled task "' + TASK_NAME + '" — running now, starts on logon.' };
}

function uninstallSchtasks() {
    tryRun('schtasks', ['/end', '/tn', TASK_NAME]);
    const r = tryRun('schtasks', ['/delete', '/tn', TASK_NAME, '/f']);
    return { ok: true, message: r.ok ? 'removed scheduled task.' : 'no scheduled task to remove.' };
}

function statusSchtasks() {
    const r = tryRun('schtasks', ['/query', '/tn', TASK_NAME]);
    return { ok: true, message: r.ok ? r.out.trim().split('\n').slice(-1)[0] : 'task not installed.' };
}

// ---------- dispatch ----------

function install(opts = {}) {
    const interval = Number(opts.interval) > 0 ? Number(opts.interval) : 60;
    switch (process.platform) {
        case 'linux': return installSystemd(interval);
        case 'darwin': return installLaunchd(interval);
        case 'win32': return installSchtasks(interval);
        default: return { ok: false, message: 'unsupported platform: ' + process.platform };
    }
}

function uninstall() {
    switch (process.platform) {
        case 'linux': return uninstallSystemd();
        case 'darwin': return uninstallLaunchd();
        case 'win32': return uninstallSchtasks();
        default: return { ok: false, message: 'unsupported platform: ' + process.platform };
    }
}

function status() {
    switch (process.platform) {
        case 'linux': return statusSystemd();
        case 'darwin': return statusLaunchd();
        case 'win32': return statusSchtasks();
        default: return { ok: false, message: 'unsupported platform: ' + process.platform };
    }
}

module.exports = { install, uninstall, status };
