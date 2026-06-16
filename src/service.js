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

const TT_JS = path.resolve(__dirname, '..', 'bin', 'tt.js');
const NODE = process.execPath;

const SERVICES = {
    sync: {
        key: 'sync',
        label: 'token-tracker',
        launchdLabel: 'com.token-tracker.watch',
        taskName: 'token-tracker-watch',
        desc: 'token-tracker continuous sync+push',
        args: (interval) => ['watch', '--interval', String(interval)],
    },
    presence: {
        key: 'presence',
        label: 'token-tracker-presence',
        launchdLabel: 'token-tracker-presence',
        taskName: 'token-tracker-presence',
        desc: 'token-tracker Discord presence',
        args: () => ['presence', '--all'],
    },
};

function serviceSpecs(opts = {}) {
    const specs = [SERVICES.sync];
    if (opts.presence) specs.push(SERVICES.presence);
    return specs;
}

function uninstallSpecs(opts = {}) {
    if (opts.presenceOnly || (opts.presence && !opts.syncToo)) return [SERVICES.presence];
    return [SERVICES.sync, SERVICES.presence];
}

function argsFor(spec, interval) {
    return typeof spec.args === 'function' ? spec.args(interval) : spec.args;
}

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

function systemdUnitPath(spec) {
    return path.join(SYSTEMD_DIR, spec.label + '.service');
}

function systemdUnitText(spec, interval) {
    const env = ttEnv();
    const envLines = Object.entries(env).map(([k, v]) => 'Environment=' + k + '=' + v).join('\n');
    return [
        '[Unit]',
        'Description=' + spec.desc,
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=' + NODE + ' ' + TT_JS + ' ' + argsFor(spec, interval).join(' '),
        envLines,
        // Presence exits non-zero when Discord is not up yet; Restart=always
        // retries it until Discord is available.
        'Restart=always',
        'RestartSec=10',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].filter((l) => l !== '').join('\n') + '\n';
}

function installSystemd(spec, interval) {
    const unit = systemdUnitPath(spec);
    fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
    fs.writeFileSync(unit, systemdUnitText(spec, interval));
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', spec.label + '.service']);
    // Linger lets the service run without an active login session (after reboot,
    // before the user logs in). Best-effort: may need polkit; warn if it fails.
    const linger = tryRun('loginctl', ['enable-linger', os.userInfo().username]);
    let msg = 'installed systemd user service (' + unit + ') — running now, starts on boot.';
    if (!linger.ok) msg += '\nnote: could not enable-linger (service may pause when logged out). run: sudo loginctl enable-linger ' + os.userInfo().username;
    return { ok: true, message: msg };
}

function uninstallSystemd(spec) {
    tryRun('systemctl', ['--user', 'disable', '--now', spec.label + '.service']);
    try { fs.unlinkSync(systemdUnitPath(spec)); } catch {}
    tryRun('systemctl', ['--user', 'daemon-reload']);
    return { ok: true, message: 'removed systemd user service: ' + spec.label + '.' };
}

function statusSystemd(spec) {
    const active = tryRun('systemctl', ['--user', 'is-active', spec.label + '.service']);
    const enabled = tryRun('systemctl', ['--user', 'is-enabled', spec.label + '.service']);
    return {
        ok: true,
        message: spec.key + ': ' + active.out.trim() + ' / ' + enabled.out.trim()
            + (fs.existsSync(systemdUnitPath(spec)) ? '' : ' (not installed)'),
    };
}

// ---------- macOS: launchd LaunchAgent ----------

const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

function plistPath(spec) {
    return path.join(PLIST_DIR, spec.launchdLabel + '.plist');
}

function plistText(spec, interval) {
    const env = ttEnv();
    const envDict = Object.keys(env).length
        ? '  <key>EnvironmentVariables</key>\n  <dict>\n'
          + Object.entries(env).map(([k, v]) => '    <key>' + k + '</key><string>' + v + '</string>').join('\n')
          + '\n  </dict>\n'
        : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        + '<plist version="1.0">\n<dict>\n'
        + '  <key>Label</key><string>' + spec.launchdLabel + '</string>\n'
        + '  <key>ProgramArguments</key>\n  <array>\n'
        + '    <string>' + NODE + '</string>\n'
        + '    <string>' + TT_JS + '</string>\n'
        + argsFor(spec, interval).map((arg) => '    <string>' + arg + '</string>').join('\n') + '\n'
        + '  </array>\n'
        + envDict
        + '  <key>RunAtLoad</key><true/>\n'
        // Presence exits non-zero when Discord is not up yet; KeepAlive retries
        // it until Discord is available.
        + '  <key>KeepAlive</key><true/>\n'
        + '</dict>\n</plist>\n';
}

function installLaunchd(spec, interval) {
    const file = plistPath(spec);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plistText(spec, interval));
    const uid = process.getuid();
    // bootout first so re-install reloads cleanly; ignore if not loaded.
    tryRun('launchctl', ['bootout', 'gui/' + uid + '/' + spec.launchdLabel]);
    const boot = tryRun('launchctl', ['bootstrap', 'gui/' + uid, file]);
    if (!boot.ok) {
        // Older macOS fallback.
        tryRun('launchctl', ['load', '-w', file]);
    }
    tryRun('launchctl', ['kickstart', 'gui/' + uid + '/' + spec.launchdLabel]);
    return { ok: true, message: 'installed launchd agent (' + file + ') — running now, starts on login.' };
}

function uninstallLaunchd(spec) {
    const uid = process.getuid();
    tryRun('launchctl', ['bootout', 'gui/' + uid + '/' + spec.launchdLabel]);
    tryRun('launchctl', ['unload', '-w', plistPath(spec)]);
    try { fs.unlinkSync(plistPath(spec)); } catch {}
    return { ok: true, message: 'removed launchd agent: ' + spec.launchdLabel + '.' };
}

function statusLaunchd(spec) {
    const r = tryRun('launchctl', ['list', spec.launchdLabel]);
    const missing = fs.existsSync(plistPath(spec)) ? '' : ' (not installed)';
    return { ok: true, message: spec.key + ': ' + (r.ok ? 'service loaded.' : 'service not loaded' + missing + '.') };
}

// ---------- Windows: Scheduled Task ----------

function schtasksArgs(spec, interval) {
    const tr = '"' + NODE + '" "' + TT_JS + '" ' + argsFor(spec, interval).join(' ');
    return ['/create', '/tn', spec.taskName, '/tr', tr, '/sc', 'onlogon', '/rl', 'limited', '/f'];
}

function installSchtasks(spec, interval) {
    // ONLOGON task that runs the watch loop. /f overwrites on re-install.
    const r = tryRun('schtasks', schtasksArgs(spec, interval));
    if (!r.ok) return { ok: false, message: 'schtasks create failed: ' + r.out.trim() };
    tryRun('schtasks', ['/run', '/tn', spec.taskName]);
    return { ok: true, message: 'installed scheduled task "' + spec.taskName + '" — running now, starts on logon.' };
}

function uninstallSchtasks(spec) {
    tryRun('schtasks', ['/end', '/tn', spec.taskName]);
    const r = tryRun('schtasks', ['/delete', '/tn', spec.taskName, '/f']);
    return { ok: true, message: r.ok ? 'removed scheduled task: ' + spec.taskName + '.' : 'no scheduled task to remove: ' + spec.taskName + '.' };
}

function statusSchtasks(spec) {
    const r = tryRun('schtasks', ['/query', '/tn', spec.taskName]);
    return { ok: true, message: spec.key + ': ' + (r.ok ? r.out.trim().split('\n').slice(-1)[0] : 'task not installed.') };
}

// ---------- dispatch ----------

function platformInstall(spec, interval) {
    switch (process.platform) {
        case 'linux': return installSystemd(spec, interval);
        case 'darwin': return installLaunchd(spec, interval);
        case 'win32': return installSchtasks(spec, interval);
        default: return { ok: false, message: 'unsupported platform: ' + process.platform };
    }
}

function platformUninstall(spec) {
    switch (process.platform) {
        case 'linux': return uninstallSystemd(spec);
        case 'darwin': return uninstallLaunchd(spec);
        case 'win32': return uninstallSchtasks(spec);
        default: return { ok: false, message: 'unsupported platform: ' + process.platform };
    }
}

function platformStatus(spec) {
    switch (process.platform) {
        case 'linux': return statusSystemd(spec);
        case 'darwin': return statusLaunchd(spec);
        case 'win32': return statusSchtasks(spec);
        default: return { ok: false, message: 'unsupported platform: ' + process.platform };
    }
}

function install(opts = {}) {
    const interval = Number(opts.interval) > 0 ? Number(opts.interval) : 60;
    const results = serviceSpecs(opts).map((spec) => platformInstall(spec, interval));
    return {
        ok: results.every((r) => r.ok),
        message: results.map((r) => r.message).join('\n'),
    };
}

function uninstall(opts = {}) {
    const results = uninstallSpecs(opts).map((spec) => platformUninstall(spec));
    return {
        ok: results.every((r) => r.ok),
        message: results.map((r) => r.message).join('\n'),
    };
}

function status() {
    const results = [SERVICES.sync, SERVICES.presence].map((spec) => platformStatus(spec));
    return {
        ok: results.every((r) => r.ok),
        message: results.map((r) => r.message).join('\n'),
    };
}

module.exports = {
    SERVICES,
    install,
    plistText,
    schtasksArgs,
    status,
    systemdUnitText,
    uninstall,
};
