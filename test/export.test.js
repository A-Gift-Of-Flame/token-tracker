'use strict';

// BL-118 export: CSV/Markdown of an aggregated report or raw records, read-only
// over a seeded temp store.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-export-'));
process.env.TOKEN_TRACKER_DIR = tmp;
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const exp = require('../src/export');

fs.writeFileSync(path.join(dataDir, '2026-06.jsonl'), [
    { id: 'a', ts: '2026-06-02T00:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', provider: 'anthropic', project: 'demo', input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.0483362500001, priced: true },
    { id: 'b', ts: '2026-06-01T00:00:00Z', agent: 'codex', model: 'gpt-5.5', provider: 'openai', input: 200, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1, priced: true },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

// The seeded records are hardcoded to June 2026; pin the clock inside that
// month so the 'month' period always covers them (mock resets per test).
const FIXED_NOW = new Date('2026-06-15T12:00:00Z').getTime();

test('records export: headers, oldest-first, project-less → blank, cost rounded', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
    const data = exp.records('month');
    assert.deepEqual(data.headers, ['ts', 'agent', 'model', 'provider', 'project', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'priced', 'id']);
    assert.equal(data.rows.length, 2);
    assert.equal(data.rows[0][1], 'codex', 'oldest first (b before a)');
    assert.equal(data.rows[0][4], '', 'missing project → blank');
    assert.equal(data.rows[1][4], 'demo');
    assert.equal(data.rows[1][9], 0.048336, 'cost rounded to 6 decimals');
});

test('aggregate export: grouped rows + TOTAL', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
    const data = exp.aggregate('month', 'agent');
    assert.deepEqual(data.headers, ['agent', 'requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost']);
    const total = data.rows[data.rows.length - 1];
    assert.equal(total[0], 'TOTAL');
    assert.equal(total[1], 2, 'two requests total');
    assert.equal(total[6], 1.048336, 'total cost rounded');
});

test('toCsv quotes fields with commas/quotes', () => {
    const out = exp.toCsv({ headers: ['a', 'b'], rows: [['x,y', 'he said "hi"'], ['plain', '1']] });
    const lines = out.split('\n');
    assert.equal(lines[0], 'a,b');
    assert.equal(lines[1], '"x,y","he said ""hi"""');
    assert.equal(lines[2], 'plain,1');
});

test('toMd builds a pipe table and escapes pipes', () => {
    const out = exp.toMd({ headers: ['k', 'v'], rows: [['a|b', '2']] });
    const lines = out.split('\n');
    assert.equal(lines[0], '| k | v |');
    assert.equal(lines[1], '| --- | --- |');
    assert.equal(lines[2], '| a\\|b | 2 |');
});
