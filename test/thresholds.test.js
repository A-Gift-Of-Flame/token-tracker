'use strict';

// BL-114 cost ceilings: optional daily/monthly caps in budget.json that warn
// (no daemon) on tt sync + reports when current spend crosses them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-thresh-'));
process.env.TOKEN_TRACKER_DIR = tmp;
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const budget = require('../src/budget');

test('saveBudget patches one ceiling without clobbering the other', () => {
    assert.deepEqual(budget.loadBudget(), { monthly: null, daily: null });
    budget.saveBudget({ monthly: 200 });
    budget.saveBudget({ daily: 25 });
    assert.deepEqual(budget.loadBudget(), { monthly: 200, daily: 25 }, 'both kept');
    budget.saveBudget({ daily: null }); // clear daily only
    assert.deepEqual(budget.loadBudget(), { monthly: 200, daily: null }, 'monthly preserved');
    assert.equal(budget.saveBudget({ monthly: -5 }).monthly, null, 'non-positive clears');
});

test('thresholdWarnings fires per crossed ceiling', () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0);
    // Guard: if today is the 1st the two records share a day — push the earlier
    // one to the 1st regardless; today is mid-month in practice.
    const key = now.toISOString().slice(0, 7);
    fs.writeFileSync(path.join(dataDir, key + '.jsonl'), [
        { id: 'today', ts: now.toISOString(), agent: 'x', model: 'm', input: 0, output: 0, cost: 30 },
        { id: 'earlier', ts: monthStart.toISOString(), agent: 'x', model: 'm', input: 0, output: 0, cost: 80 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    budget.saveBudget({ monthly: 100, daily: 25 });
    let w = budget.thresholdWarnings();
    assert.equal(w.length, 2, w.join(' | '));
    assert.ok(w.some((s) => s.includes('daily cost $30.00 over ceiling $25.00')), w[0]);
    assert.ok(w.some((s) => s.includes('monthly cost') && s.includes('over ceiling $100.00')), w[1]);

    budget.saveBudget({ daily: 50 }); // today's $30 now under the daily cap
    w = budget.thresholdWarnings();
    assert.equal(w.length, 1, 'only monthly remains: ' + w.join(' | '));
    assert.ok(w[0].includes('monthly'), w[0]);

    budget.saveBudget({ monthly: null, daily: null });
    assert.deepEqual(budget.thresholdWarnings(), [], 'nothing set → no warnings');
});
