'use strict';

// Optional spend ceilings, persisted to ~/.token-tracker/budget.json.
// Pure config — never affects stored cost.
//   monthly: drives "% consumed" (BL-105) + --forecast projection (BL-113) on
//            the month report, and doubles as the monthly cost ceiling (BL-114).
//   daily:   daily cost ceiling (BL-114).
// thresholdWarnings() compares current today/month spend to the ceilings and is
// printed by `tt sync` and the report commands — invocations the user already
// runs, so no alert daemon (no-background-daemon invariant).
// Missing/blank file means "nothing set" (both null).

const path = require('path');
const { ROOT, readJson, writeJson } = require('./paths');

const BUDGET_FILE = path.join(ROOT, 'budget.json');

function clampPos(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function loadBudget() {
    const b = readJson(BUDGET_FILE, {}) || {};
    return { monthly: clampPos(b.monthly), daily: clampPos(b.daily) };
}

// Partial update: only keys present in `patch` change; pass null/<=0 to clear
// that key. Other keys are preserved.
function saveBudget(patch = {}) {
    const cur = loadBudget();
    const next = { monthly: cur.monthly, daily: cur.daily };
    if ('monthly' in patch) next.monthly = clampPos(patch.monthly);
    if ('daily' in patch) next.daily = clampPos(patch.daily);
    const out = {};
    if (next.monthly != null) out.monthly = next.monthly;
    if (next.daily != null) out.daily = next.daily;
    writeJson(BUDGET_FILE, out);
    return next;
}

function fmt(c) {
    return '$' + c.toFixed(2);
}

// Warnings for any ceiling the current spend has crossed. Reads stored data
// only (no sync). Returns [] when nothing is set or nothing is crossed.
function thresholdWarnings() {
    const { monthly, daily } = loadBudget();
    if (!monthly && !daily) return [];
    const { report } = require('./report');
    const out = [];
    if (daily) {
        const c = report('today', 'agent').total.cost;
        if (c > daily) out.push('⚠ daily cost ' + fmt(c) + ' over ceiling ' + fmt(daily) + ' (today)');
    }
    if (monthly) {
        const c = report('month', 'agent').total.cost;
        if (c > monthly) out.push('⚠ monthly cost ' + fmt(c) + ' over ceiling ' + fmt(monthly) + ' (this month)');
    }
    return out;
}

module.exports = { BUDGET_FILE, loadBudget, saveBudget, thresholdWarnings };
