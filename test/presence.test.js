'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const { DiscordIPC, OP, decodeFrames, encodeFrame } = require('../src/presence/discord-ipc');
const { PresenceEngine } = require('../src/presence/engine');
const { renderPresenceActivity } = require('../src/presence/render');

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Discord IPC frame encode/decode uses opcode int32 LE, length int32 LE, JSON payload', () => {
    const frame = encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', ok: true });
    assert.equal(frame.readInt32LE(0), OP.FRAME);
    assert.equal(frame.readInt32LE(4), Buffer.byteLength(JSON.stringify({ cmd: 'SET_ACTIVITY', ok: true })));
    const decoded = decodeFrames(Buffer.concat([frame.slice(0, 9), frame.slice(9)]));
    assert.equal(decoded.frames.length, 1);
    assert.deepEqual(decoded.frames[0], { op: OP.FRAME, payload: { cmd: 'SET_ACTIVITY', ok: true } });
    assert.equal(decoded.rest.length, 0);
});

test('DiscordIPC gates SET_ACTIVITY until READY', async () => {
    class FakeSocket extends EventEmitter {
        constructor() {
            super();
            this.destroyed = false;
        }
        write(chunk, cb) {
            const decoded = decodeFrames(Buffer.from(chunk));
            received.push(...decoded.frames);
            if (cb) cb();
            return true;
        }
        destroy() {
            this.destroyed = true;
            this.emit('close');
        }
        end() {
            this.destroy();
        }
    }
    const received = [];
    const socket = new FakeSocket();
    const ipc = new DiscordIPC('client-1', {
        paths: ['discord-ipc-0'],
        existsSync: () => true,
        createConnection: () => {
            process.nextTick(() => socket.emit('connect'));
            return socket;
        },
        readyTimeoutMs: 1000,
        pid: 123,
    });
    const connectPromise = ipc.connect();
    await wait(25);
    assert.equal(await ipc.setActivity({ details: 'too early' }), false);
    assert.equal(received.filter((f) => f.payload.cmd === 'SET_ACTIVITY').length, 0);
    assert.equal(received[0].op, OP.HANDSHAKE);
    assert.equal(received[0].payload.client_id, 'client-1');
    socket.emit('data', encodeFrame(OP.FRAME, { evt: 'READY' }));
    await connectPromise;
    assert.equal(await ipc.setActivity({ details: 'ready' }), true);
    const set = received.find((f) => f.payload.cmd === 'SET_ACTIVITY');
    assert.ok(set, 'SET_ACTIVITY sent after READY');
    assert.equal(set.payload.args.pid, 123);
    assert.deepEqual(set.payload.args.activity, { details: 'ready' });
    ipc.destroy();
});

test('renderer labels stale, estimated, exact, and missing fields truthfully', () => {
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const stale = renderPresenceActivity({
        status: 'stale',
        agent: 'codex',
        project: null,
        model: 'gpt-5.5',
        tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        cost: { amount: 0.42, estimated: true },
        timestamps: { lastActivityAt: '2026-06-15T11:50:00.000Z' },
        missing: ['project'],
    }, { now, freshnessMs: 60000 });
    assert.match(stale.details, /idle|stale/);
    assert.doesNotMatch(stale.details + ' ' + stale.state, /\blive\b/i);
    assert.match(stale.state, /stale/);
    assert.match(stale.state, /\$0\.42 est/);
    assert.match(stale.state, /project missing/);

    const exact = renderPresenceActivity({
        status: 'fresh',
        agent: 'claude-code',
        project: 'token-tracker',
        model: 'claude-opus-4-8',
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        cost: { amount: 1.25, exact: true },
        timestamps: { lastActivityAt: '2026-06-15T11:59:59.000Z' },
        missing: [],
    }, { now, freshnessMs: 60000 });
    assert.match(exact.details, /recent/);
    assert.match(exact.state, /\$1\.25 exact/);
});

test('foreground Ctrl-C path clears activity:null then exits', async () => {
    class FakeIPC {
        constructor() { this.calls = []; this.destroyed = false; }
        async connect() { this.calls.push(['connect']); }
        async setActivity(activity) { this.calls.push(['setActivity', activity]); return true; }
        async clear() { this.calls.push(['clear']); return this.setActivity(null); }
        destroy() { this.destroyed = true; }
    }
    class FakeSource extends EventEmitter {
        constructor() { super(); this.stopped = false; }
        start() {
            this.emit('state', {
                status: 'fresh',
                agent: 'codex',
                project: 'token-tracker',
                model: 'gpt-5.5',
                tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
                cost: { amount: 0.01, exact: true },
                timestamps: { lastActivityAt: new Date().toISOString() },
                missing: [],
            });
        }
        stop() { this.stopped = true; }
    }
    const ipc = new FakeIPC();
    const source = new FakeSource();
    const proc = new EventEmitter();
    const exits = [];
    const engine = new PresenceEngine({
        ipc,
        source,
        processObj: proc,
        stdout: { write() {} },
        stderr: { write() {} },
        exit: (code) => exits.push(code),
    });
    await engine.start();
    proc.emit('SIGINT');
    await engine.done;
    assert.equal(source.stopped, true);
    assert.equal(ipc.destroyed, true);
    assert.deepEqual(ipc.calls.at(-1), ['setActivity', null]);
    assert.deepEqual(exits, [0]);
});

test('StorePresenceSource scans only the newest month file (no full-ledger reads)', () => {
    const { StorePresenceSource } = require('../src/presence/source');
    const reads = [];
    const fakeStore = {
        listMonthFiles: () => ['2026-05.jsonl', '2026-06.jsonl'],
        readRecords: (file) => {
            reads.push(file);
            return file === '2026-06.jsonl'
                ? [{ ts: '2026-06-15T10:00:00.000Z', agent: 'codex', project: 'tt', model: 'gpt-5.5', input: 10, output: 5, cost: 0.01, priced: true }]
                : [{ ts: '2026-05-01T00:00:00.000Z', agent: 'old' }];
        },
    };
    const src = new StorePresenceSource({ store: fakeStore });
    const states = [];
    src.on('state', (s) => states.push(s));
    src.poll();
    assert.deepEqual(reads, ['2026-06.jsonl']); // only the latest month, never 2026-05
    assert.equal(states.length, 1);
    assert.equal(states[0].agent, 'codex');
    assert.equal(states[0].model, 'gpt-5.5');
});
