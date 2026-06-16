'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const { PresenceEngine } = require('../src/presence/engine');
const { PresenceMultiplexer } = require('../src/presence/multiplex');
const { renderMultiplexActivity, renderPresenceActivity } = require('../src/presence/render');

const BASE = Date.parse('2026-06-16T12:00:00.000Z');

class FakeSource extends EventEmitter {
    constructor(initialState = null) {
        super();
        this.initialState = initialState;
        this.started = false;
        this.stopped = false;
    }

    start() {
        this.started = true;
        if (this.initialState) this.emit('state', this.initialState);
    }

    stop() {
        this.stopped = true;
    }

    push(state) {
        this.emit('state', state);
    }
}

class FakeIPC {
    constructor() {
        this.calls = [];
        this.destroyed = false;
    }

    async connect() {
        this.calls.push(['connect']);
    }

    async setActivity(activity) {
        this.calls.push(['setActivity', activity]);
        return true;
    }

    async clear() {
        this.calls.push(['clear']);
        return this.setActivity(null);
    }

    destroy() {
        this.destroyed = true;
    }
}

function ts(deltaMs) {
    return new Date(BASE + deltaMs).toISOString();
}

function state(agent, deltaMs, overrides = {}) {
    return {
        status: 'active',
        agent,
        project: agent + '-project',
        model: agent + '-model',
        activity: 'Working',
        tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 25 },
        cost: { amount: 0.10, currency: 'USD', exact: true, exactFlag: true, estimated: false, estimateFlag: false },
        timestamps: { lastActivityAt: ts(deltaMs), observedAt: ts(0) },
        missing: [],
        ...overrides,
    };
}

function multiplexer(entries) {
    const mux = new PresenceMultiplexer({
        freshnessMs: 60000,
        now: () => BASE,
        sources: entries,
    });
    const seen = [];
    mux.on('state', (combined) => seen.push(combined));
    mux.start();
    return { mux, seen };
}

test('multiplexer headline is picked by tier before recency', () => {
    const claude = new FakeSource(state('claude-code', -30000));
    const codex = new FakeSource(state('codex', -1000));
    const { mux, seen } = multiplexer([
        { name: 'claude', tier: 2, source: claude },
        { name: 'codex', tier: 1, source: codex },
    ]);

    assert.equal(seen.at(-1).headline.agent, 'claude-code');
    assert.deepEqual(seen.at(-1).background.map((s) => s.agent), ['codex']);
    mux.stop();
    assert.equal(claude.stopped, true);
    assert.equal(codex.stopped, true);
});

test('multiplexer tiebreaks same-tier sources by recency', () => {
    const codex = new FakeSource(state('codex', -20000));
    const gemini = new FakeSource(state('gemini-cli', -5000));
    const { seen } = multiplexer([
        { name: 'codex', tier: 1, source: codex },
        { name: 'gemini', tier: 1, source: gemini },
    ]);

    assert.equal(seen.at(-1).headline.agent, 'gemini-cli');
    assert.deepEqual(seen.at(-1).background.map((s) => s.agent), ['codex']);
});

test('multiplex renderer appends labelled bg aggregate for other live agents', () => {
    const combined = {
        status: 'active',
        headline: state('claude-code', -1000, {
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            cost: { amount: 0.50, exact: true, exactFlag: true },
        }),
        background: [
            state('codex', -2000, {
                tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
                cost: { amount: 0.10, exact: true, exactFlag: true },
            }),
            state('gemini-cli', -3000, {
                tokens: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 },
                cost: { amount: 0.23 },
            }),
        ],
    };

    const rendered = renderMultiplexActivity(combined, { now: BASE, freshnessMs: 60000 });
    assert.match(rendered.details, /claude-code recent/);
    assert.match(rendered.state, /\+2 bg/);
    assert.match(rendered.state, /\$0\.33 est/);
    assert.match(rendered.state, /450 tok/);
    assert.doesNotMatch(rendered.state, /codex bg|gemini-cli bg|claude-code bg/);
});

test('multiplexer excludes stale, idle, and too-old sources independently', () => {
    const live = new FakeSource(state('codex', -1000));
    const stale = new FakeSource(state('claude-code', -500, { status: 'stale' }));
    const idle = new FakeSource(state('gemini-cli', -500, { status: 'idle' }));
    const old = new FakeSource(state('opencode', -120000));
    const { seen } = multiplexer([
        { name: 'live', tier: 1, source: live },
        { name: 'stale', tier: 2, source: stale },
        { name: 'idle', tier: 1, source: idle },
        { name: 'old', tier: 1, source: old },
    ]);

    assert.equal(seen.at(-1).headline.agent, 'codex');
    assert.deepEqual(seen.at(-1).background, []);
});

test('solo live agent degrades to headline without bg tail', () => {
    const rendered = renderMultiplexActivity({
        status: 'active',
        headline: state('codex', -1000),
        background: [],
    }, { now: BASE, freshnessMs: 60000 });

    assert.match(rendered.details, /codex recent/);
    assert.doesNotMatch(rendered.state, /\bbg\b/);
});

test('no live sources render the idle activity', () => {
    const mux = new PresenceMultiplexer({
        freshnessMs: 60000,
        now: () => BASE,
        sources: [{ name: 'codex', tier: 1, source: new FakeSource(state('codex', -120000)) }],
    });
    const seen = [];
    mux.on('state', (combined) => seen.push(combined));
    mux.start();

    assert.deepEqual(seen.at(-1), { status: 'idle' });
    assert.deepEqual(
        renderMultiplexActivity(seen.at(-1), { now: BASE }),
        renderPresenceActivity({ status: 'idle' }, { now: BASE })
    );
});

test('single-source renderer and engine path remain non-multiplexed', async () => {
    const sourceState = state('codex', 0, {
        timestamps: { lastActivityAt: new Date().toISOString(), observedAt: new Date().toISOString() },
    });
    const expected = renderPresenceActivity(sourceState, { freshnessMs: 60000 });
    assert.doesNotMatch(expected.state, /\bbg\b/);

    const ipc = new FakeIPC();
    const proc = new EventEmitter();
    const source = new FakeSource(sourceState);
    const engine = new PresenceEngine({
        ipc,
        source,
        freshnessMs: 60000,
        processObj: proc,
        stdout: { write() {} },
        stderr: { write() {} },
        exit: () => {},
    });
    await engine.start();

    assert.deepEqual(ipc.calls.at(-1), ['setActivity', expected]);
    await engine.shutdown(0);
});
