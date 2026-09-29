'use strict';

// Headless always-on ingest: a sync+push loop with no HTTP server. This is the
// portable core of "push token usage to the VPS continuously" — it runs wherever
// Node runs (Linux/macOS/Windows); only the boot-time supervisor differs per OS
// (systemd user unit / launchd plist / Task Scheduler). `tt serve` already does
// this loop, but couples it to the dashboard server; watch is the dependency-free
// variant for machines that only need to feed the VPS.
//
// The no-background-daemon invariant in budget.js still holds for the CLI: nothing
// here is spawned implicitly. `tt watch` is an explicit, foreground process the
// user (or their OS supervisor) starts and stops.

const fs = require('fs');
const path = require('path');
const { sync } = require('./collectors');
const { ROOT } = require('./paths');

// Single instance, newest wins. Each watcher writes its pid here on start and
// exits at the next tick once another watcher has claimed the file. This covers
// re-installing the service: on Windows, ending the task kills conhost but leaves
// its node child running, so without this the old and new loops would both sync
// into the same store.
const PID_FILE = path.join(ROOT, 'watch.pid');

function claimWatch(pid = process.pid) {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid));
}

function ownsWatch(pid = process.pid) {
    try {
        return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === pid;
    } catch {
        return true; // pidfile gone: nobody else claimed it, keep running
    }
}

// One iteration. Never throws — a transient collector/network failure must not
// kill a long-running watcher. Returns the sync result (or null on hard failure)
// so callers/tests can assert. `log`/`errlog` are injectable for tests.
async function watchTick({ offline = false, log = console.log, errlog = console.error } = {}) {
    let res;
    try {
        res = await sync({ offline });
    } catch (err) {
        errlog('sync failed: ' + (err && err.message ? err.message : err));
        return null;
    }
    const added = Object.values(res.added).reduce((a, b) => a + b, 0);
    const stamp = new Date().toISOString();
    if (res.push) {
        log(stamp + '  synced +' + added + ', pushed ' + res.push.pushed + ' to ' + res.push.endpoint);
    } else if (res.pushError) {
        errlog(stamp + '  synced +' + added + ', auto-push failed: ' + res.pushError + ' (will retry)');
    } else if (added > 0) {
        log(stamp + '  synced +' + added + ', push skipped (autoPush off or no remote)');
    }
    return res;
}

// Loop forever, ticking every interval seconds. Resolves only on a thrown
// non-tick error; the setInterval keeps the process alive (intentionally NOT
// unref'd — the whole point is to stay running).
async function watch({ offline = false, interval = 60, exit = process.exit } = {}) {
    if (!(interval > 0)) throw new Error('watch needs --interval > 0');
    console.log('token-tracker watch: sync+push every ' + interval + 's  (Ctrl-C to stop)');
    claimWatch();
    await watchTick({ offline });
    const timer = setInterval(() => {
        if (!ownsWatch()) {
            console.log('token-tracker watch: a newer watcher took over; exiting.');
            clearInterval(timer);
            exit(0);
            return;
        }
        watchTick({ offline });
    }, interval * 1000);
    return timer;
}

module.exports = { watch, watchTick, claimWatch, ownsWatch, PID_FILE };
