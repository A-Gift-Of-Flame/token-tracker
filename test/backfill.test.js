'use strict';

// BL-121 historical project backfill: patch old claude-code records' `project`
// from a requestId→project map (built from on-disk transcripts in production;
// injected here). Only claude-code records are touched; already-attributed and
// unmatched records are left alone.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-backfill-'));
process.env.TOKEN_TRACKER_DIR = tmp;
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const monthFile = path.join(dataDir, '2026-06.jsonl');

const { backfillProjects } = require('../src/backfill');
const store = require('../src/store');

function seed() {
    fs.writeFileSync(monthFile, [
        { id: 'claude-code:r1', ts: '2026-06-01T00:00:00Z', agent: 'claude-code', model: 'm', input: 1, output: 1, cost: 0 },
        { id: 'claude-code:r2', ts: '2026-06-01T01:00:00Z', agent: 'claude-code', model: 'm', input: 1, output: 1, cost: 0, project: 'kept' },
        { id: 'claude-code:r3', ts: '2026-06-01T02:00:00Z', agent: 'claude-code', model: 'm', input: 1, output: 1, cost: 0 }, // no map entry
        { id: 'codex:r4', ts: '2026-06-01T03:00:00Z', agent: 'codex', model: 'gpt-5.5', input: 1, output: 1, cost: 0 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const map = new Map([
    ['claude-code:r1', 'token-tracker'],
    ['claude-code:r2', 'other'], // ignored: r2 already has a project
    ['codex:r4', 'nope'],        // ignored: not a claude-code record
]);

test('backfill attributes only unattributed claude-code records', () => {
    seed();
    const r = backfillProjects({ map });
    assert.equal(r.records, 3, '3 claude-code records counted');
    assert.equal(r.patched, 1, 'only r1 patched');
    assert.equal(r.alreadyHad, 1, 'r2 kept');
    assert.equal(r.unmatched, 1, 'r3 had no map entry');

    const recs = store.readRecords(monthFile);
    const byId = Object.fromEntries(recs.map((x) => [x.id, x]));
    assert.equal(byId['claude-code:r1'].project, 'token-tracker', 'patched');
    assert.equal(byId['claude-code:r2'].project, 'kept', 'existing project untouched');
    assert.equal('project' in byId['claude-code:r3'], false, 'unmatched stays bare');
    assert.equal('project' in byId['codex:r4'], false, 'codex untouched');
});

test('--dry-run reports without writing', () => {
    seed();
    const before = fs.readFileSync(monthFile, 'utf8');
    const r = backfillProjects({ map, dryRun: true });
    assert.equal(r.patched, 1);
    assert.equal(fs.readFileSync(monthFile, 'utf8'), before, 'file unchanged');
});
