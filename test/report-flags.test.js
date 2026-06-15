'use strict';

// BL-104: reporting upgrades — rolling --last window, --trend sparkline,
// --compact cost-only view. Exercises periodRange + render directly so the
// store is untouched (deterministic).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { periodRange, render } = require('../src/report');
const { cacheSavings, ratesFor } = require('../src/pricing');

function isoLocal(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

test('periodRange honors lastDays rolling window', () => {
    const r = periodRange('today', { lastDays: 7 });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const expectFrom = new Date(today); expectFrom.setDate(today.getDate() - 6);
    assert.equal(isoLocal(r.from), isoLocal(expectFrom), 'from = today - 6');
    assert.equal(r.to, null);
    assert.match(r.label, /^last 7 days \(from /);
});

test('periodRange lastDays overrides the period word', () => {
    // even with period "month", lastDays drives the window
    const r = periodRange('month', { lastDays: 1 });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    assert.equal(isoLocal(r.from), isoLocal(today), 'last 1 day = today only');
});

const sample = {
    label: 'test',
    rows: [
        { key: 'a', requests: 10, input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, cost: 1.5 },
        { key: 'b', requests: 2, input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
    ],
    total: { requests: 12, input: 1050, output: 520, cacheRead: 200, cacheWrite: 0, cost: 1.75, unpriced: 0 },
};

test('compact view drops token columns, keeps reqs + cost', () => {
    const out = render(sample, 'agent', { compact: true });
    const header = out.split('\n').find((l) => l.includes('cost'));
    assert.ok(header.includes('reqs'), 'has reqs column');
    assert.ok(!/input|output|cache/.test(header), 'no token columns');
    assert.ok(out.includes('$1.75'), 'total cost shown');
    assert.ok(out.includes('$1.50'), 'row cost shown');
});

test('full view keeps all columns', () => {
    const out = render(sample, 'agent', {});
    const header = out.split('\n').find((l) => l.includes('cost'));
    assert.ok(/input/.test(header) && /output/.test(header) && /cache/.test(header));
});

// --- BL-116 efficiency metrics ---------------------------------------------

test('cacheSavings = no-cache counterfactual minus actual cache cost', () => {
    // builtin claude-opus: input 5e-6, cache read 0.1x = 0.5e-6, write 1.25x = 6.25e-6
    const rec = { input: 0, output: 0, cacheRead: 1000, cacheWrite: 100 };
    const r = ratesFor({}, 'claude-opus-4-8', 'anthropic');
    const expected = (1000 + 100) * r.inC - (1000 * r.crC + 100 * r.cwC);
    assert.ok(Math.abs(cacheSavings({}, 'claude-opus-4-8', 'anthropic', rec) - expected) < 1e-12);
    assert.ok(expected > 0, 'read-heavy record saves money');
});

test('cacheSavings is 0 for an unpriced model', () => {
    assert.equal(cacheSavings({}, 'totally-unknown-model', 'mystery', { cacheRead: 999 }), 0);
});

test('efficiency block renders $/M output, cache hit, savings', () => {
    const eff = { costPerMOutput: 41.83, cacheHitRate: 0.875, cacheSaved: 12.5 };
    const out = render({ ...sample, efficiency: eff }, 'agent', {});
    assert.ok(out.includes('Efficiency:'));
    assert.ok(out.includes('$/M output:    $41.83'));
    assert.ok(out.includes('cache hit:     87.5%'));
    assert.ok(out.includes('cache savings: $12.50 vs no-cache'));
});

test('efficiency savings shows a note when pricing unavailable', () => {
    const eff = { costPerMOutput: null, cacheHitRate: null, cacheSaved: null };
    const out = render({ ...sample, efficiency: eff }, 'agent', {});
    assert.ok(out.includes('$/M output:    —'));
    assert.ok(out.includes('cache hit:     —'));
    assert.ok(out.includes('cache savings: — (run online for pricing)'));
});

test('trend renders a sparkline with peak day', () => {
    const trend = [
        { day: '2026-06-01', cost: 0, requests: 0 },
        { day: '2026-06-02', cost: 5, requests: 3 },
        { day: '2026-06-03', cost: 10, requests: 4 },
    ];
    const out = render({ ...sample, trend }, 'agent', {});
    assert.ok(out.includes('Daily cost trend (3 days):'));
    assert.match(out, /[▁-█]{3}/, 'three sparkline blocks');
    assert.ok(out.includes('2026-06-01 → 2026-06-03'));
    assert.ok(out.includes('peak 2026-06-03 $10.00'));
});
