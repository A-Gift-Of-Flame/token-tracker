'use strict';

// BL-108: per-collector smoke tests over staged fixtures. node --test runs each
// file in its own process, so we fix HOME (claude-code transcripts, opencode
// db) and TOKEN_TRACKER_DIR (inbox) once up front — before requiring any
// collector, since opencode/paths compute their roots at module load.

const os = require('os');
const fs = require('fs');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-smoke-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-smoke-root-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
process.env.TOKEN_TRACKER_DIR = root;

const { test } = require('node:test');
const assert = require('node:assert/strict');

// --- claude-code: transcript JSONL under ~/.claude/projects/<dir>/ -----------

test('claude-code collector ingests transcript usage with project', () => {
    const dir = path.join(home, '.claude', 'projects', '-tmp-demo');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }), // skipped: no usage
        JSON.stringify({
            type: 'assistant', requestId: 'req-A', timestamp: '2026-06-10T00:00:00Z',
            cwd: '/home/me/projects/demo-app',
            message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
        }),
        JSON.stringify({
            type: 'assistant', requestId: 'req-B', timestamp: '2026-06-10T00:01:00Z',
            cwd: '/home/me/projects/demo-app',
            message: { model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 1 } },
        }),
    ];
    fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.join('\n') + '\n');

    const cc = require('../src/collectors/claude-code');
    const recs = cc.collect({});
    assert.equal(recs.length, 2, 'two assistant usage lines, user line skipped');
    const a = recs.find((r) => r.id === 'claude-code:req-A');
    assert.equal(a.agent, 'claude-code');
    assert.equal(a.provider, 'anthropic');
    assert.equal(a.model, 'claude-opus-4-8');
    assert.equal(a.project, 'demo-app', 'project from cwd basename');
    assert.equal(a.input, 10);
    assert.equal(a.output, 5);
    assert.equal(a.cacheRead, 100);
    assert.equal(a.cacheWrite, 20);
});

// --- opencode: assistant rows in the sqlite message table --------------------

test('opencode collector reads assistant rows from the sqlite db', () => {
    const { DatabaseSync } = require('node:sqlite');
    const dbDir = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(path.join(dbDir, 'opencode.db'));
    db.exec('CREATE TABLE message (id TEXT, time_created INTEGER, data TEXT)');
    const ins = db.prepare('INSERT INTO message (id, time_created, data) VALUES (?, ?, ?)');
    ins.run('m1', 1000, JSON.stringify({
        role: 'assistant', modelID: 'claude-sonnet-4-6', providerID: 'anthropic',
        time: { created: 1700000000000, completed: 1700000001000 },
        tokens: { input: 50, output: 20, reasoning: 5, cache: { read: 200, write: 30 } },
    }));
    ins.run('u1', 1001, JSON.stringify({ role: 'user', tokens: null })); // skipped
    db.close();

    delete require.cache[require.resolve('../src/collectors/opencode')];
    const opencode = require('../src/collectors/opencode');
    const recs = opencode.collect({});
    assert.equal(recs.length, 1, 'only the assistant row');
    const r = recs[0];
    assert.equal(r.id, 'opencode:m1');
    assert.equal(r.agent, 'opencode');
    assert.equal(r.model, 'claude-sonnet-4-6');
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.input, 50);
    assert.equal(r.output, 25, 'output includes reasoning (20 + 5)');
    assert.equal(r.cacheRead, 200);
    assert.equal(r.cacheWrite, 30);
});

// --- gemini-cli: JSONL session files under ~/.gemini/tmp/<project>/chats/ ----

test('gemini-cli collector ingests session turns with project and skips non-gemini lines', () => {
    const chatsDir = path.join(home, '.gemini', 'tmp', 'my-project', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const lines = [
        JSON.stringify({ sessionId: 'sess-1', startTime: '2026-06-13T00:00:00Z', kind: 'main' }),
        JSON.stringify({ id: 'u-1', timestamp: '2026-06-13T00:00:00Z', type: 'user', content: [{ text: 'hi' }] }),
        JSON.stringify({
            id: 'g-1', timestamp: '2026-06-13T00:00:05Z', type: 'gemini',
            content: 'Hello', model: 'gemini-2-5-pro',
            tokens: { input: 1000, output: 50, cached: 500, thoughts: 30, tool: 10, total: 1590 },
        }),
        JSON.stringify({ id: 'i-1', timestamp: '2026-06-13T00:00:06Z', type: 'info', content: 'info' }),
        JSON.stringify({
            id: 'g-2', timestamp: '2026-06-13T00:00:10Z', type: 'gemini',
            content: 'Goodbye', model: 'gemini-2-5-flash',
            tokens: { input: 200, output: 100, cached: 0, thoughts: 0, tool: 0, total: 300 },
        }),
    ];
    fs.writeFileSync(path.join(chatsDir, 'session.jsonl'), lines.join('\n') + '\n');

    const geminiCli = require('../src/collectors/gemini-cli');
    const recs = geminiCli.collect({}, path.join(home, '.gemini'));
    assert.equal(recs.length, 2, 'two gemini turns, user/info lines skipped');

    const a = recs.find((r) => r.id === 'gemini-cli:g-1');
    assert.equal(a.agent, 'gemini-cli');
    assert.equal(a.provider, 'gemini');
    assert.equal(a.model, 'gemini-2-5-pro');
    assert.equal(a.project, 'my-project');
    assert.equal(a.input, 1010, 'input includes tool tokens (1000 + 10)');
    assert.equal(a.output, 80, 'output includes thoughts tokens (50 + 30)');
    assert.equal(a.cacheRead, 500);
    assert.equal(a.cacheWrite, 0);

    const b = recs.find((r) => r.id === 'gemini-cli:g-2');
    assert.equal(b.input, 200);
    assert.equal(b.output, 100);
    assert.equal(b.cacheRead, 0);
});

// --- copilot-cli: events.jsonl under ~/.copilot/session-state/<id>/ ----------

test('copilot-cli collector extracts per-model records from session.shutdown event', () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb';
    const dir = path.join(home, '.copilot', 'session-state', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const events = [
        JSON.stringify({ type: 'session.start', data: { sessionId, context: { cwd: '/home/me/projects/my-app' } }, timestamp: '2026-06-14T10:00:00Z' }),
        JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-haiku-4.5' }, timestamp: '2026-06-14T10:00:01Z' }),
        JSON.stringify({ type: 'user.message', data: { content: 'hello' }, timestamp: '2026-06-14T10:00:02Z' }),
        JSON.stringify({ type: 'assistant.message', data: { model: 'claude-haiku-4.5', outputTokens: 20 }, timestamp: '2026-06-14T10:00:03Z' }),
        JSON.stringify({
            type: 'session.shutdown',
            data: {
                sessionStartTime: 1781474400000,
                modelMetrics: {
                    'claude-haiku-4.5': {
                        usage: { inputTokens: 1500, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 1200, reasoningTokens: 0 },
                    },
                },
            },
            timestamp: '2026-06-14T10:00:04Z',
        }),
    ];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.join('\n') + '\n');

    const copilotCli = require('../src/collectors/copilot-cli');
    const state = {};
    const recs = copilotCli.collect(state, path.join(home, '.copilot'));

    assert.equal(recs.length, 1, 'one record for one model');
    const r = recs[0];
    assert.equal(r.id, 'copilot-cli:' + sessionId + ':claude-haiku-4.5');
    assert.equal(r.agent, 'copilot-cli');
    assert.equal(r.model, 'claude-haiku-4.5');
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.project, 'my-app', 'project from cwd basename');
    assert.equal(r.input, 1500);
    assert.equal(r.output, 20);
    assert.equal(r.cacheRead, 400);
    assert.equal(r.cacheWrite, 1200);
    assert.equal(r.ts, new Date(1781474400000).toISOString(), 'ts from sessionStartTime');

    assert.deepEqual(state.processedSessions, [sessionId], 'processed session saved to state');

    // re-collect: already-processed session should not re-emit
    const recs2 = copilotCli.collect(state, path.join(home, '.copilot'));
    assert.equal(recs2.length, 0, 'idempotent: no records on re-collect');
});

test('copilot-cli skips session with no shutdown event (still active)', () => {
    const sessionId = 'cccccccc-0000-0000-0000-dddddddddddd';
    const dir = path.join(home, '.copilot', 'session-state', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const events = [
        JSON.stringify({ type: 'session.start', data: { sessionId, context: { cwd: '/tmp' } }, timestamp: '2026-06-14T11:00:00Z' }),
        JSON.stringify({ type: 'user.message', data: { content: 'ping' }, timestamp: '2026-06-14T11:00:01Z' }),
    ];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.join('\n') + '\n');

    const copilotCli = require('../src/collectors/copilot-cli');
    const recs = copilotCli.collect({}, path.join(home, '.copilot'));
    // filter: only the sessions from this test (not from prior tests in this process)
    const ours = recs.filter(r => r.id.includes(sessionId));
    assert.equal(ours.length, 0, 'no record for active session without shutdown');
});

// --- inbox (dropbox): JSONL dropped in ~/.token-tracker/inbox/ ---------------

test('inbox collector ingests dropped jsonl and marks it imported', () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, 'gemini-cli.jsonl');
    fs.writeFileSync(file,
        JSON.stringify({ ts: '2026-06-10T00:00:00Z', model: 'gemini-3-pro', input: 1200, output: 340 }) + '\n'
        + JSON.stringify({ ts: '2026-06-10T00:05:00Z', agent: 'custom', model: 'x', input: 1, output: 2 }) + '\n');

    const inboxCollector = require('../src/collectors/dropbox');
    const recs = inboxCollector.collect({});
    assert.equal(recs.length, 2);
    assert.equal(recs[0].agent, 'gemini-cli', 'agent falls back to file name');
    assert.equal(recs[0].model, 'gemini-3-pro');
    assert.equal(recs[0].input, 1200);
    assert.equal(recs[1].agent, 'custom', 'explicit agent honored');
    assert.equal(fs.existsSync(file), false, 'original consumed');
    assert.equal(fs.existsSync(file + '.imported'), true, 'renamed to .imported');
});
