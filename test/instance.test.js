'use strict';

// Single-instance pidfile shared by watch + presence. Restarting the Windows
// scheduled task leaves the old node child running, so the old instance must
// notice the new claim (or the uninstall stand-down) and exit on its own.

const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-instance-root-'));
process.env.TOKEN_TRACKER_DIR = root;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claimInstance, instanceFile, ownsInstance } = require('../src/instance');
const { watchInstance } = require('../src/presence/engine');

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeEngine() {
    const engine = new EventEmitter();
    engine.shutdowns = [];
    engine.stdout = { write() {} };
    engine._write = () => {};
    engine.done = new Promise((resolve) => { engine._resolveDone = resolve; });
    engine.shutdown = (code) => {
        engine.shutdowns.push(code);
        engine._resolveDone(code);
        return engine.done;
    };
    return engine;
}

test('pid 0 (service uninstall) makes every running instance stand down', () => {
    claimInstance('watch', 111);
    assert.equal(ownsInstance('watch', 111), true);
    claimInstance('watch', 0);
    assert.equal(ownsInstance('watch', 111), false);
    fs.rmSync(instanceFile('watch'), { force: true });
});

test('presence instances are independent of the watch pidfile', () => {
    claimInstance('watch', 111);
    claimInstance('presence', 222);
    assert.equal(ownsInstance('watch', 111), true);
    assert.equal(ownsInstance('presence', 222), true);
    fs.rmSync(instanceFile('watch'), { force: true });
    fs.rmSync(instanceFile('presence'), { force: true });
});

test('older presence shuts down once a newer one claims the pidfile', async () => {
    const old = fakeEngine();
    watchInstance(old, { pid: 111, intervalMs: 10 });
    await wait(30);
    assert.deepEqual(old.shutdowns, [], 'still the owner: keeps running');

    const newer = fakeEngine();
    watchInstance(newer, { pid: 222, intervalMs: 10 });
    await wait(40);
    assert.deepEqual(old.shutdowns, [0], 'old presence clears and exits 0');
    assert.deepEqual(newer.shutdowns, []);

    newer.shutdown(0);
    fs.rmSync(instanceFile('presence'), { force: true });
});
