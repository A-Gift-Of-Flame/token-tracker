'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPresenceSource } = require('../src/presence/engine');
const { renderPresenceActivity } = require('../src/presence/render');
const { readCodexPresenceState } = require('../src/presence/codex-source');
const { readGeminiPresenceState } = require('../src/presence/gemini-source');
const { readOpenCodePresenceState } = require('../src/presence/opencode-source');

function tmpdir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pricingTable() {
    return {
        'gpt-5-codex': {
            input_cost_per_token: 1e-6,
            output_cost_per_token: 10e-6,
            cache_read_input_token_cost: 0.1e-6,
            cache_creation_input_token_cost: 1.25e-6,
        },
        'gemini-2-5-pro': {
            input_cost_per_token: 2e-6,
            output_cost_per_token: 8e-6,
            cache_read_input_token_cost: 0.2e-6,
        },
        'claude-sonnet-4-6': {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            cache_read_input_token_cost: 0.3e-6,
            cache_creation_input_token_cost: 3.75e-6,
        },
    };
}

test('Codex live-tail source emits raw activity/project, estimated cost, and stale transition', () => {
    const root = tmpdir('tt-presence-codex-');
    const rollout = path.join(root, 'rollout.jsonl');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'codex-rollout.jsonl'), rollout);
    fs.appendFileSync(rollout, '{"timestamp":"2026-06-13T10:00:12.000Z"'); // incomplete line ignored

    const fresh = readCodexPresenceState({
        file: rollout,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T10:00:20.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(fresh.status, 'active');
    assert.equal(fresh.source, 'codex-rollout-tail');
    assert.equal(fresh.ceiling, 'codex-live-tail');
    assert.equal(fresh.agent, 'codex');
    assert.equal(fresh.project, 'proj');
    assert.equal(fresh.model, 'gpt-5-codex');
    assert.equal(fresh.activity, 'Using exec_command');
    assert.deepEqual(fresh.tokens, { input: 500, output: 350, cacheRead: 3000, cacheWrite: 0 });
    assert.equal(fresh.cost.estimated, true);
    assert.equal(fresh.cost.exact, false);
    assert.equal(fresh.missing.includes('activity'), false);
    assert.match(renderPresenceActivity(fresh, {
        now: Date.parse('2026-06-13T10:00:20.000Z'),
        freshnessMs: 60000,
    }).state, /Using exec_command/);

    const stale = readCodexPresenceState({
        file: rollout,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T10:05:00.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(stale.status, 'stale');
});

test('Gemini live-tail source leaves activity null/missing and labels cost estimated', () => {
    const root = tmpdir('tt-presence-gemini-');
    const chatsDir = path.join(root, 'tmp', 'gemini-proj', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const session = path.join(chatsDir, 'session-1.jsonl');
    fs.writeFileSync(session, [
        JSON.stringify({ id: 'u1', timestamp: '2026-06-13T11:00:00.000Z', type: 'user', content: 'hi' }),
        JSON.stringify({
            id: 'g1',
            timestamp: '2026-06-13T11:00:10.000Z',
            type: 'gemini',
            content: 'hello',
            model: 'gemini-2-5-pro',
            tokens: { input: 1000, output: 80, cached: 200, thoughts: 20, tool: 5, total: 1305 },
        }),
        JSON.stringify({ id: 'i1', timestamp: '2026-06-13T11:00:11.000Z', type: 'info', content: 'done' }),
    ].join('\n') + '\n{"type":"gemini"');

    const fresh = readGeminiPresenceState({
        geminiRoot: root,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T11:00:30.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(fresh.status, 'active');
    assert.equal(fresh.source, 'gemini-session-tail');
    assert.equal(fresh.ceiling, 'gemini-cli-live-tail');
    assert.equal(fresh.agent, 'gemini-cli');
    assert.equal(fresh.project, 'gemini-proj');
    assert.equal(fresh.model, 'gemini-2-5-pro');
    assert.equal(fresh.activity, null);
    assert.equal(fresh.missing.includes('activity'), true);
    assert.deepEqual(fresh.tokens, { input: 1005, output: 100, cacheRead: 200, cacheWrite: 0 });
    assert.equal(fresh.cost.estimated, true);
    assert.equal(fresh.cost.exact, false);
    assert.doesNotMatch(renderPresenceActivity(fresh, {
        now: Date.parse('2026-06-13T11:00:30.000Z'),
        freshnessMs: 60000,
    }).state, /Responding|Using|tool/i);

    const stale = readGeminiPresenceState({
        geminiRoot: root,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T11:03:00.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(stale.status, 'stale');
});

test('OpenCode live-tail source reads part activity and estimates hosted-provider cost', () => {
    const { DatabaseSync } = require('node:sqlite');
    const root = tmpdir('tt-presence-opencode-');
    const dbPath = path.join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec([
        'CREATE TABLE session (id TEXT, directory TEXT, path TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)',
        'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
        'CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
        'CREATE TABLE event (id TEXT, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)',
    ].join(';'));
    const t0 = Date.parse('2026-06-13T12:00:00.000Z');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses1',
        '/home/me/token-tracker',
        '/home/me/token-tracker',
        JSON.stringify({ id: 'claude-sonnet-4-6', providerID: 'anthropic' }),
        99,
        0,
        0,
        0,
        0,
        0,
        t0,
        t0 + 9000
    );
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg1', 'ses1', t0 + 2000, t0 + 6000, JSON.stringify({
        role: 'assistant',
        modelID: 'claude-sonnet-4-6',
        providerID: 'anthropic',
        path: { cwd: '/home/me/token-tracker' },
        time: { created: t0 + 2000, completed: t0 + 6000 },
        tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 10 } },
    }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('part1', 'msg1', 'ses1', t0 + 8000, t0 + 9000, JSON.stringify({
        type: 'tool',
        tool: 'bash',
        time: { start: t0 + 8000, end: t0 + 9000 },
    }));
    db.close();

    const fresh = readOpenCodePresenceState({
        dbPath,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T12:00:20.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(fresh.status, 'active');
    assert.equal(fresh.source, 'opencode-db-tail');
    assert.equal(fresh.ceiling, 'opencode-live-tail');
    assert.equal(fresh.agent, 'opencode');
    assert.equal(fresh.project, 'token-tracker');
    assert.equal(fresh.model, 'claude-sonnet-4-6');
    assert.equal(fresh.activity, 'Using bash');
    assert.deepEqual(fresh.tokens, { input: 100, output: 35, cacheRead: 20, cacheWrite: 10 });
    assert.equal(fresh.cost.estimated, true);
    assert.equal(fresh.cost.exact, false);
    assert.notEqual(fresh.cost.amount, 99, 'unconfirmed source cost is not trusted for hosted provider');

    const stale = readOpenCodePresenceState({
        dbPath,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T12:03:00.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(stale.status, 'stale');
});

test('OpenCode local ollama zero source cost can be labelled exact', () => {
    const { DatabaseSync } = require('node:sqlite');
    const root = tmpdir('tt-presence-opencode-local-');
    const dbPath = path.join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec([
        'CREATE TABLE session (id TEXT, directory TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)',
        'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
        'CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    ].join(';'));
    const t0 = Date.parse('2026-06-13T12:30:00.000Z');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses-local',
        '/home/me/local-proj',
        JSON.stringify({ id: 'qwen3-8b', providerID: 'ollama' }),
        0,
        10,
        2,
        1,
        0,
        0,
        t0,
        t0 + 1000
    );
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('part-local', 'msg-local', 'ses-local', t0 + 500, t0 + 1000, JSON.stringify({
        type: 'reasoning',
        time: { start: t0 + 500, end: t0 + 1000 },
    }));
    db.close();

    const state = readOpenCodePresenceState({
        dbPath,
        pricingTable: pricingTable(),
        now: Date.parse('2026-06-13T12:30:10.000Z'),
        freshnessMs: 60000,
    });
    assert.equal(state.activity, 'Reasoning');
    assert.deepEqual(state.tokens, { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 });
    assert.equal(state.cost.amount, 0);
    assert.equal(state.cost.exact, true);
    assert.equal(state.cost.estimated, false);
});

test('foreground source resolver accepts store, claude, codex, gemini, opencode and live timers unref', () => {
    for (const name of ['store', 'claude', 'codex', 'gemini', 'opencode']) {
        assert.ok(createPresenceSource(name), name + ' resolves');
    }
    assert.throws(() => createPresenceSource('cursor'), /unknown presence source/);

    for (const name of ['claude', 'codex', 'gemini', 'opencode']) {
        const source = createPresenceSource(name, { pollMs: 1000, now: Date.parse('2026-06-13T00:00:00.000Z') });
        source.start();
        assert.equal(source.timer.hasRef(), false, name + ' timer is unrefd');
        source.stop();
    }
});
