'use strict';

// BL-106 reprice: recompute stored costs from the current price table.
// Seeds a temp store + a fresh pricing cache (so getPricing returns it as
// "live" with no network), then exercises reprice end to end.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-reprice-'));
process.env.TOKEN_TRACKER_DIR = tmp;

const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const monthFile = path.join(dataDir, '2026-06.jsonl');

const TABLE = {
    'anthropic/claude-opus-4-8': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
};

function seed(records, { live = true } = {}) {
    fs.writeFileSync(monthFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(tmp, 'pricing.json'), JSON.stringify({
        fetchedAt: live ? Date.now() : 0, // stale (0) makes getPricing report live:false
        table: TABLE,
    }));
}

const { reprice } = require('../src/reprice');
const store = require('../src/store');

test('recomputes costs and rewrites the store', async () => {
    seed([
        { id: 'a', ts: '2026-06-01T00:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', provider: 'anthropic', input: 1000, output: 1000, cost: 0, priced: false },
        { id: 'b', ts: '2026-06-02T00:00:00Z', agent: 'codex', model: 'gpt-5.5', provider: 'openai', input: 500, output: 0, cost: 0.5, priced: true },
    ]);
    const r = await reprice({ offline: true });
    assert.equal(r.aborted, undefined);
    assert.equal(r.records, 2);
    assert.equal(r.changed, 2);
    // Claude record now priced (0.03); gpt-5.5 absent from table → unpriced, cost 0.
    assert.ok(Math.abs(r.newTotal - 0.03) < 1e-12, 'newTotal=' + r.newTotal);
    assert.equal(r.nowPriced, 1, 'claude went priced');
    assert.equal(r.lostPricing, 1, 'gpt lost pricing');

    const recs = store.readRecords(monthFile);
    assert.ok(Math.abs(recs[0].cost - 0.03) < 1e-12, 'claude cost written');
    assert.equal(recs[0].priced, true);
    assert.equal(recs[1].cost, 0);
    assert.equal(recs[1].priced, false);
    // ids/tokens untouched
    assert.equal(recs[0].id, 'a');
    assert.equal(recs[1].input, 500);
});

test('--dry-run previews without writing', async () => {
    seed([
        { id: 'a', ts: '2026-06-01T00:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', provider: 'anthropic', input: 1000, output: 1000, cost: 0, priced: false },
    ]);
    const before = fs.readFileSync(monthFile, 'utf8');
    const r = await reprice({ offline: true, dryRun: true });
    assert.equal(r.changed, 1);
    assert.ok(Math.abs(r.newTotal - 0.03) < 1e-12);
    assert.equal(fs.readFileSync(monthFile, 'utf8'), before, 'file unchanged on dry-run');
});

test('refuses on offline/stale pricing unless forced', async () => {
    seed([
        { id: 'a', ts: '2026-06-01T00:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', provider: 'anthropic', input: 1000, output: 1000, cost: 99, priced: true },
    ], { live: false });
    const blocked = await reprice({ offline: true });
    assert.equal(blocked.aborted, true, 'aborted when not live');
    assert.equal(fs.readFileSync(monthFile, 'utf8').includes('"cost":99'), true, 'untouched');

    const forced = await reprice({ offline: true, force: true });
    assert.equal(forced.aborted, undefined);
    assert.equal(forced.changed, 1, 'force overrides guard');
});
