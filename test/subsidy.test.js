'use strict';

// Subscription subsidy: plan detection, fee config, subsidy math.
// Runs against a temp HOME (auth/credentials fixtures) and a temp
// TOKEN_TRACKER_DIR (store + config), so nothing real is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AVG_MONTH_DAYS = 30.4375;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function stage({ chatgptPlan, claudePlan } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-subs-home-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-subs-dir-'));
    if (chatgptPlan !== undefined) {
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        const claims = { 'https://api.openai.com/auth': { chatgpt_plan_type: chatgptPlan } };
        const jwt = 'h.' + b64(claims) + '.s';
        fs.writeFileSync(path.join(home, '.codex', 'auth.json'),
            JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt } }));
    }
    if (claudePlan !== undefined) {
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
            JSON.stringify({ claudeAiOauth: { subscriptionType: claudePlan, rateLimitTier: 'default_claude_ai' } }));
    }
    return { home, dir };
}

function writeRecords(dir, recs) {
    const byMonth = new Map();
    for (const r of recs) {
        const k = r.ts.slice(0, 7);
        if (!byMonth.has(k)) byMonth.set(k, []);
        byMonth.get(k).push(JSON.stringify(r));
    }
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    for (const [k, lines] of byMonth) {
        fs.writeFileSync(path.join(dir, 'data', k + '.jsonl'), lines.join('\n') + '\n');
    }
}

// Load a fresh subscriptions module bound to the staged env.
function withEnv({ home, dir }, fn) {
    const ph = process.env.HOME;
    const pd = process.env.TOKEN_TRACKER_DIR;
    if (home !== undefined) process.env.HOME = home;
    if (dir !== undefined) process.env.TOKEN_TRACKER_DIR = dir;
    for (const m of ['../src/paths', '../src/store', '../src/report', '../src/subscriptions']) {
        delete require.cache[require.resolve(m)];
    }
    try { return fn(require('../src/subscriptions')); }
    finally {
        process.env.HOME = ph;
        if (pd === undefined) delete process.env.TOKEN_TRACKER_DIR; else process.env.TOKEN_TRACKER_DIR = pd;
    }
}

test('detects plans from codex JWT and claude credentials', () => {
    const env = stage({ chatgptPlan: 'pro', claudePlan: 'max' });
    const plans = withEnv(env, (s) => s.detectPlans());
    assert.equal(plans.codex.provider, 'chatgpt');
    assert.equal(plans.codex.plan, 'pro');
    assert.equal(plans['claude-code'].provider, 'claude');
    assert.equal(plans['claude-code'].plan, 'max');
});

test('missing auth files yield null plan, no throw', () => {
    const env = stage({}); // no fixtures written
    const plans = withEnv(env, (s) => s.detectPlans());
    assert.equal(plans.codex.plan, null);
    assert.equal(plans['claude-code'].plan, null);
});

test('fee config: defaults, override merge, bad values rejected', () => {
    const env = stage({});
    withEnv(env, (s) => {
        assert.equal(s.loadConfig().fees.claude.pro, 20, 'seeded default');
        s.saveConfig({ fees: { claude: { pro: 17 } } });
        const cfg = s.loadConfig();
        assert.equal(cfg.fees.claude.pro, 17, 'override persisted');
        assert.equal(cfg.fees.claude.max, 100, 'untouched default survives merge');
        s.saveConfig({ fees: { claude: { pro: 'abc' } } }); // non-numeric ignored
        s.saveConfig({ fees: { claude: { pro: -5 } } });    // negative ignored
        assert.equal(s.loadConfig().fees.claude.pro, 17, 'bad values rejected');
    });
});

test('subsidy math: net, coverage, proration, free plan, non-subscription', () => {
    const env = stage({ chatgptPlan: 'free', claudePlan: 'pro' });
    const ts = new Date().toISOString();
    writeRecords(env.dir, [
        { id: 'a', ts, agent: 'claude-code', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 100, priced: true },
        { id: 'b', ts, agent: 'claude-code', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 50, priced: true },
        { id: 'c', ts, agent: 'codex', model: 'gpt', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 5, priced: true },
        { id: 'd', ts, agent: 'opencode', model: 'qwen', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false },
    ]);
    const r = withEnv(env, (s) => {
        s.saveConfig({ fees: { claude: { pro: 30 } } });
        return s.subsidy('today', { lastDays: 30 });
    });

    assert.equal(r.days, 30);
    const months = 30 / AVG_MONTH_DAYS;

    const cc = r.rows.find((x) => x.agent === 'claude-code');
    assert.equal(cc.spend, 150);
    assert.equal(cc.monthlyFee, 30);
    assert.ok(Math.abs(cc.proratedFee - 30 * months) < 1e-9, 'fee prorated by days/avg-month');
    assert.ok(Math.abs(cc.net - (150 - 30 * months)) < 1e-9);
    assert.ok(Math.abs(cc.coverage - 150 / (30 * months)) < 1e-9);

    const cx = r.rows.find((x) => x.agent === 'codex');
    assert.equal(cx.plan, 'free');
    assert.equal(cx.monthlyFee, 0, 'free = $0');
    assert.equal(cx.proratedFee, 0);
    assert.equal(cx.net, 5, 'all spend is net subsidy when fee is 0');
    assert.equal(cx.coverage, null, 'no coverage when fee is 0');

    const oc = r.rows.find((x) => x.agent === 'opencode');
    assert.equal(oc.provider, null, 'local model: no subscription');
    assert.equal(oc.monthlyFee, null);
    assert.equal(oc.net, null);

    // totals only fold subscription-backed rows (claude + codex), not opencode
    assert.equal(r.totals.subscriptions, 2);
    assert.ok(Math.abs(r.totals.proratedFee - 30 * months) < 1e-9);
    assert.equal(r.totals.spend, 155, 'spend total includes all agents');
});

test('crossover: burn above fee → flat verdict, break-even inside a month', () => {
    const env = stage({ claudePlan: 'pro' });
    const ts = new Date().toISOString();
    // $300 over 10 days = $30/day; $30/mo fee → crossover $30/30.4375 ≈ $0.986/day.
    writeRecords(env.dir, [
        { id: 'a', ts, agent: 'claude-code', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 300, priced: true },
    ]);
    const r = withEnv(env, (s) => {
        s.saveConfig({ fees: { claude: { pro: 30 } } });
        return s.subsidy('today', { lastDays: 10 });
    });

    const cc = r.rows.find((x) => x.agent === 'claude-code').crossover;
    assert.ok(Math.abs(cc.dailyBurn - 30) < 1e-9, '$300/10d = $30/day');
    assert.ok(Math.abs(cc.crossoverDaily - 30 / AVG_MONTH_DAYS) < 1e-9);
    assert.ok(Math.abs(cc.breakEvenDays - 30 / 30) < 1e-9, 'fee/burn = 1 day');
    assert.equal(cc.verdict, 'flat', 'burn far over crossover → flat wins');
    assert.ok(cc.breakEvenDays <= AVG_MONTH_DAYS, 'earned back inside a month');

    // aggregate crossover mirrors the single subscription
    assert.equal(r.totals.crossover.verdict, 'flat');
    assert.ok(Math.abs(r.totals.crossover.dailyBurn - 30) < 1e-9);
});

test('crossover: burn under fee → metered verdict; null fee/zero burn → no block', () => {
    const env = stage({ claudePlan: 'pro' });
    const ts = new Date().toISOString();
    // $3 over 30 days = $0.10/day, well under the $0.66/day crossover for a $20 fee.
    writeRecords(env.dir, [
        { id: 'a', ts, agent: 'claude-code', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 3, priced: true },
    ]);
    const r = withEnv(env, (s) => s.subsidy('today', { lastDays: 30 })); // default pro = $20

    const cc = r.rows.find((x) => x.agent === 'claude-code').crossover;
    assert.equal(cc.verdict, 'metered', 'low burn → metered would be cheaper');
    assert.ok(cc.breakEvenDays > AVG_MONTH_DAYS, 'takes longer than a month to earn back');
    assert.equal(r.totals.crossover.verdict, 'metered');

    // unknown plan → null fee → no crossover block
    const env2 = stage({}); // no claude credentials
    const r2 = withEnv(env2, (s) => {
        writeRecords(env2.dir, [
            { id: 'a', ts, agent: 'claude-code', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 9, priced: true },
        ]);
        return s.subsidy('today', { lastDays: 30 });
    });
    assert.equal(r2.rows[0].crossover, null, 'no detected plan → null crossover');
    assert.equal(r2.totals.crossover, null, 'no subscriptions → null aggregate crossover');
});
