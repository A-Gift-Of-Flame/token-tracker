'use strict';

// BL-105 budget awareness + BL-113 run-rate forecast. Exercises budget config
// load/save (temp dir) and render() directly so the store stays untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Point the data dir at a temp location BEFORE loading modules that read paths.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-budget-'));
process.env.TOKEN_TRACKER_DIR = tmp;

const budget = require('../src/budget');
const { render } = require('../src/report');

const sample = {
    label: 'this month (2026-06)',
    rows: [{ key: 'a', requests: 10, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 100 }],
    total: { requests: 10, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 100, unpriced: 0 },
};

test('budget save/load round-trips and clamps non-positive to null', () => {
    assert.equal(budget.loadBudget().monthly, null, 'unset → null');
    assert.equal(budget.saveBudget({ monthly: 200 }).monthly, 200);
    assert.equal(budget.loadBudget().monthly, 200, 'persists');
    assert.equal(budget.saveBudget({ monthly: -5 }).monthly, null, 'negative cleared');
    assert.equal(budget.saveBudget({ monthly: 0 }).monthly, null, 'zero cleared');
});

test('month report shows budget % consumed', () => {
    const out = render(sample, 'agent', { period: 'month', budget: 400 });
    assert.ok(out.includes('Budget: $100.00 / $400.00 (25% consumed)'), out);
});

test('budget line only on the month period (monthly figure)', () => {
    const out = render(sample, 'agent', { period: 'week', budget: 400 });
    assert.ok(!out.includes('Budget:'), 'no budget line on week');
});

test('forecast projects period-end and flags overshoot vs budget', () => {
    const result = { ...sample, forecast: { projected: 500, elapsed: 12, totalDays: 30 } };
    const out = render(result, 'agent', { period: 'month', budget: 400 });
    assert.ok(out.includes('Forecast: $500.00 by period end (12.0 of 30 days elapsed)'), out);
    assert.ok(out.includes('125% of budget, OVER by $100.00'), out);
});

test('forecast renders without a budget (no budget-relative suffix)', () => {
    const result = { ...sample, forecast: { projected: 500, elapsed: 5, totalDays: 7 } };
    const out = render(result, 'agent', { period: 'week', budget: 0 });
    assert.ok(out.includes('Forecast: $500.00 by period end (5.0 of 7 days elapsed)'), out);
    assert.ok(!out.includes('of budget'), 'no budget comparison');
});
