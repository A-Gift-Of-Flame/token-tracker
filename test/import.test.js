'use strict';

// BL-119: multi-machine merge — import dedups by record id against the store
// and within the batch; --ledger export round-trips losslessly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-import-'));
process.env.TOKEN_TRACKER_DIR = tmp;
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Seed the local store with one record (id 'a').
fs.writeFileSync(path.join(dataDir, '2026-06.jsonl'),
    JSON.stringify({ id: 'a', ts: '2026-06-02T00:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.5, priced: true }) + '\n');

const { importLedger } = require('../src/import');
const store = require('../src/store');
const exp = require('../src/export');

function writeLedger(name, recs) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return f;
}

test('import: new ids appended, existing id deduped, cross-month routed', () => {
    const f = writeLedger('laptop.jsonl', [
        { id: 'a', ts: '2026-06-02T00:00:00Z', agent: 'claude-code', model: 'x', input: 1, output: 1, cost: 9 }, // dup of seeded
        { id: 'b', ts: '2026-06-03T00:00:00Z', agent: 'codex', model: 'gpt-5.5', input: 2, output: 2, cost: 1 },
        { id: 'c', ts: '2026-05-30T00:00:00Z', agent: 'opencode', model: 'y', input: 3, output: 3, cost: 2 }, // prior month
    ]);
    const r = importLedger([f]);
    assert.equal(r.total, 3);
    assert.equal(r.added, 2, 'b and c are new');
    assert.equal(r.duplicate, 1, 'a already stored');
    assert.equal(r.invalid, 0);
    // c routed to its own month file by ts.
    assert.ok(fs.existsSync(path.join(dataDir, '2026-05.jsonl')), 'cross-month append created May file');
    const ids = store.loadIds();
    assert.ok(ids.has('a') && ids.has('b') && ids.has('c'));
});

test('re-import is idempotent (all duplicate, store unchanged)', () => {
    const before = store.loadIds().size;
    const f = writeLedger('again.jsonl', [
        { id: 'b', ts: '2026-06-03T00:00:00Z', agent: 'codex', model: 'gpt-5.5', input: 2, output: 2, cost: 1 },
        { id: 'c', ts: '2026-05-30T00:00:00Z', agent: 'opencode', model: 'y', input: 3, output: 3, cost: 2 },
    ]);
    const r = importLedger([f]);
    assert.equal(r.added, 0);
    assert.equal(r.duplicate, 2);
    assert.equal(store.loadIds().size, before, 'store size unchanged');
});

test('within-batch dup and invalid lines are skipped, dry-run writes nothing', () => {
    const f = writeLedger('mixed.jsonl', [
        { id: 'd', ts: '2026-06-04T00:00:00Z', agent: 'x', model: 'm', cost: 1 },
        { id: 'd', ts: '2026-06-04T00:00:00Z', agent: 'x', model: 'm', cost: 1 }, // in-batch dup
        { id: 'e' }, // no ts → invalid
        { noid: true, ts: '2026-06-04T00:00:00Z' }, // no id → invalid
    ]);
    // append a raw bad json line too.
    fs.appendFileSync(f, '{not json\n');
    const r = importLedger([f], { dryRun: true });
    assert.equal(r.added, 1, 'only first d counts');
    assert.equal(r.duplicate, 1, 'second d is in-batch dup');
    assert.equal(r.invalid, 3, 'missing-ts, missing-id, bad-json');
    assert.ok(!store.loadIds().has('d'), 'dry-run did not write');
});

test('ledger export → import round-trips losslessly', () => {
    const recs = exp.ledger('all', { period: 'all' });
    assert.ok(recs.length >= 3);
    const out = exp.toJsonl(recs);
    // Parse back; full fidelity preserved (priced field, exact cost).
    const seeded = recs.find((r) => r.id === 'a');
    assert.equal(seeded.cost, 0.5);
    assert.equal(seeded.priced, true);
    // Oldest first.
    assert.ok(recs[0].ts <= recs[recs.length - 1].ts);
    // Importing our own export is all-duplicate (idempotent).
    const f = writeLedger('selfexport.jsonl', recs);
    const r = importLedger([f]);
    assert.equal(r.added, 0);
    assert.equal(r.duplicate, recs.length);
    assert.ok(out.length > 0);
});
