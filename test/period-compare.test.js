'use strict';

// BL-115 period compare: `--vs last` adds a delta block (cost/requests/tokens,
// abs + %) for the period vs the prior one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cmp-'));
process.env.TOKEN_TRACKER_DIR = tmp;
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const { report, render } = require('../src/report');

const now = new Date();
const thisKey = now.toISOString().slice(0, 7);
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12, 0, 0);
const prevKey = prev.toISOString().slice(0, 7);

function rec(ts, cost, input) {
    return { id: ts + ':' + cost, ts, agent: 'a', model: 'm', input, output: 0, cacheRead: 0, cacheWrite: 0, cost };
}

// current month: 2 records, cost 100, input 300
fs.writeFileSync(path.join(dataDir, thisKey + '.jsonl'),
    [rec(new Date(now.getFullYear(), now.getMonth(), 1, 9).toISOString(), 70, 200),
        rec(now.toISOString(), 30, 100)].map((r) => JSON.stringify(r)).join('\n') + '\n');
// prior month: 1 record, cost 50, input 100
fs.writeFileSync(path.join(dataDir, prevKey + '.jsonl'),
    JSON.stringify(rec(prev.toISOString(), 50, 100)) + '\n');

test('comparison computes abs + pct deltas vs last month', () => {
    const r = report('month', 'agent', { vsLast: true, period: 'month' });
    assert.ok(r.comparison, 'comparison attached');
    assert.equal(r.comparison.label, 'last month');
    const d = r.comparison.deltas;
    assert.equal(d.cost.cur, 100);
    assert.equal(d.cost.prev, 50);
    assert.equal(d.cost.abs, 50);
    assert.ok(Math.abs(d.cost.pct - 100) < 1e-9, 'cost +100%');
    assert.equal(d.requests.abs, 1, '2 vs 1');
    assert.equal(d.input.cur, 300);
    assert.equal(d.input.abs, 200);
});

test('pct is null when the prior period had nothing', () => {
    const r = report('year', 'agent', { vsLast: true, period: 'year' });
    // prior year had no records → every prev is 0, pct null
    assert.equal(r.comparison.deltas.cost.prev, 0);
    assert.equal(r.comparison.deltas.cost.pct, null);
});

test('no comparison for all-time (no fixed prior)', () => {
    const r = report('all', 'agent', { vsLast: true, period: 'all' });
    assert.equal(r.comparison, undefined);
});

test('render shows the comparison block', () => {
    const r = report('month', 'agent', { vsLast: true, period: 'month' });
    const out = render(r, 'agent', { period: 'month' });
    assert.ok(out.includes('Compared to last month:'), out);
    assert.ok(out.includes('vs'), out);
    assert.ok(/cost\s+\$100\.00\s+vs\s+\$50\.00\s+\+\$50\.00\s+\(\+100\.0%\)/.test(out), out);
});
