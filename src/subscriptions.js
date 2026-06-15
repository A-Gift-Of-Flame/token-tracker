'use strict';

// Subscription subsidy analysis.
//
// Stored record costs are always the metered, pay-as-you-go API price of the
// tokens (see pricing.js). Most frontier-model coding happens under a flat
// monthly subscription instead, so the interesting question is: how much is
// that subscription subsidizing real usage? This module answers it:
//
//   subsidy (net) = API-equivalent spend over the period
//                   − the subscription fee, prorated to that period
//   coverage      = API-equivalent spend ÷ prorated fee   (×)
//
// A positive net means the flat plan is saving money vs metered API; a
// negative net means the plan is underused for the period.
//
// The plan in use is detected dynamically from local auth/config (no secrets
// leave this module). Monthly fees are configurable (subscriptions.json under
// the data dir, editable from the dashboard) because real prices change and
// vary per user; sensible defaults are seeded.

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./store');
const { periodRange } = require('./report');
const { ROOT, readJson, writeJson } = require('./paths');

const SUBS_FILE = path.join(ROOT, 'subscriptions.json');
const DAY = 86400000;
const AVG_MONTH_DAYS = 30.4375;

// Which subscription provider backs each subscription-based agent. Agents not
// listed here (local models, metered API keys) have no subscription to subsidize.
const PROVIDER_OF = {
    'claude-code': 'claude',
    'codex': 'chatgpt',
};

// Seeded monthly fees (USD). User-editable via subscriptions.json / dashboard.
// Unknown plan names resolve to a null fee (shown as "unknown"), never a wrong $0.
const DEFAULT_FEES = {
    claude: { free: 0, pro: 20, max: 100, max_5x: 100, max_20x: 200, team: 30, enterprise: 0 },
    chatgpt: { free: 0, plus: 20, pro: 200, team: 30, business: 30, enterprise: 0 },
};

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

// --- config -----------------------------------------------------------------

function defaultConfig() {
    return { fees: JSON.parse(JSON.stringify(DEFAULT_FEES)) };
}

// Stored config deep-merged over the seeded defaults, so new default plans
// appear automatically and the user only overrides what they set.
function loadConfig() {
    const cfg = defaultConfig();
    const stored = readJson(SUBS_FILE, null);
    if (stored && stored.fees) {
        for (const provider of Object.keys(stored.fees)) {
            cfg.fees[provider] = { ...(cfg.fees[provider] || {}), ...stored.fees[provider] };
        }
    }
    return cfg;
}

// Merge a partial { fees: { provider: { plan: usd } } } and persist. Numbers
// only; non-numeric fee values are rejected so the file can't be corrupted.
function saveConfig(partial) {
    const cfg = loadConfig();
    if (partial && partial.fees) {
        for (const provider of Object.keys(partial.fees)) {
            const incoming = partial.fees[provider] || {};
            cfg.fees[provider] = cfg.fees[provider] || {};
            for (const plan of Object.keys(incoming)) {
                const v = Number(incoming[plan]);
                if (Number.isFinite(v) && v >= 0) cfg.fees[provider][plan] = v;
            }
        }
    }
    writeJson(SUBS_FILE, { fees: cfg.fees });
    return cfg;
}

// --- plan detection ----------------------------------------------------------

function decodeJwtPayload(token) {
    try {
        const seg = String(token).split('.')[1];
        if (!seg) return null;
        return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    } catch { return null; }
}

// ChatGPT/Codex plan from ~/.codex/auth.json id_token claims.
function detectChatgpt() {
    const file = path.join(os.homedir(), '.codex', 'auth.json');
    const auth = readJson(file, null);
    if (!auth) return { provider: 'chatgpt', plan: null, source: 'codex auth.json (not found)' };
    const claims = decodeJwtPayload(auth.tokens && auth.tokens.id_token) || {};
    const a = claims['https://api.openai.com/auth'] || {};
    const plan = a.chatgpt_plan_type || null;
    return {
        provider: 'chatgpt',
        plan,
        authMode: auth.auth_mode || null,
        activeUntil: a.chatgpt_subscription_active_until || null,
        source: 'codex auth.json id_token',
    };
}

// Claude plan from ~/.claude/.credentials.json (Claude Code OAuth).
function detectClaude() {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    const cred = readJson(file, null);
    const oauth = cred && cred.claudeAiOauth;
    if (!oauth) return { provider: 'claude', plan: null, source: 'claude .credentials.json (not found)' };
    return {
        provider: 'claude',
        plan: oauth.subscriptionType || null,
        rateLimitTier: oauth.rateLimitTier || null,
        source: 'claude .credentials.json',
    };
}

// agent -> detected plan info. Defensive: missing files yield plan: null.
function detectPlans() {
    const chatgpt = detectChatgpt();
    const claude = detectClaude();
    return {
        'codex': chatgpt,
        'claude-code': claude,
    };
}

// --- subsidy -----------------------------------------------------------------

function feeFor(cfg, provider, plan) {
    if (!provider || !plan) return null;
    const table = cfg.fees[provider];
    if (!table || !(plan in table)) return null;
    return table[plan];
}

// Period day-span used for proration. Bounded periods come straight from
// periodRange; "all" spans the earliest..latest record actually present.
function periodDays(from, minTs, maxTs) {
    if (from) {
        const now0 = startOfDay(new Date());
        return Math.max(1, Math.round((now0 - startOfDay(from)) / DAY) + 1);
    }
    if (minTs && maxTs) {
        return Math.max(1, Math.round((startOfDay(maxTs) - startOfDay(minTs)) / DAY) + 1);
    }
    return 1;
}

// Crossover / break-even at the current burn rate. Derived only — no stored
// state changes. Given a flat monthly fee and the metered API spend accrued
// over `days` of this period:
//
//   dailyBurn      = spend ÷ days                  (metered $/day right now)
//   crossoverDaily = monthlyFee ÷ avg-month-days   (the $/day where metered == flat)
//   breakEvenDays  = monthlyFee ÷ dailyBurn        (days at this burn to spend one fee)
//
// verdict 'flat' when burn ≥ crossover (the plan beats metered), 'metered'
// when it's under (metered would be cheaper). null fee/zero burn → null block.
function crossoverFor(monthlyFee, spend, days) {
    if (monthlyFee == null || monthlyFee <= 0 || days <= 0) return null;
    const dailyBurn = spend / days;
    const crossoverDaily = monthlyFee / AVG_MONTH_DAYS;
    const breakEvenDays = dailyBurn > 0 ? monthlyFee / dailyBurn : null;
    return {
        monthlyFee,
        dailyBurn,
        crossoverDaily,
        breakEvenDays,
        verdict: dailyBurn >= crossoverDaily ? 'flat' : 'metered',
    };
}

function subsidy(period, opts = {}) {
    const { from, to, label } = periodRange(period, opts);
    const records = store.loadRange(from ? from.toISOString() : null, to ? to.toISOString() : null);

    const byAgent = new Map();
    let minTs = null;
    let maxTs = null;
    for (const r of records) {
        if (!byAgent.has(r.agent)) byAgent.set(r.agent, { agent: r.agent, spend: 0, requests: 0 });
        const a = byAgent.get(r.agent);
        a.spend += r.cost || 0;
        a.requests += 1;
        if (!minTs || r.ts < minTs) minTs = r.ts;
        if (!maxTs || r.ts > maxTs) maxTs = r.ts;
    }

    const days = periodDays(from, minTs, maxTs);
    const months = days / AVG_MONTH_DAYS;
    const cfg = loadConfig();
    const plans = detectPlans();

    const rows = [];
    const totals = { spend: 0, proratedFee: 0, net: 0, subscriptions: 0, monthlyFee: 0 };
    for (const a of byAgent.values()) {
        const provider = PROVIDER_OF[a.agent] || null;
        const detected = provider ? plans[a.agent] : null;
        const plan = detected ? detected.plan : null;
        const monthlyFee = feeFor(cfg, provider, plan);
        const proratedFee = monthlyFee != null ? monthlyFee * months : null;
        const net = proratedFee != null ? a.spend - proratedFee : null;
        const coverage = proratedFee > 0 ? a.spend / proratedFee : null;
        rows.push({
            agent: a.agent,
            provider,
            plan,
            requests: a.requests,
            spend: a.spend,
            monthlyFee,
            proratedFee,
            net,
            coverage,
            crossover: crossoverFor(monthlyFee, a.spend, days),
        });
        totals.spend += a.spend;
        if (proratedFee != null) {
            totals.proratedFee += proratedFee;
            totals.net += net;
            totals.subscriptions += 1;
            if (monthlyFee != null) totals.monthlyFee += monthlyFee;
        }
    }
    // Subscriptions first (by spend), then metered/other agents.
    rows.sort((x, y) => (y.proratedFee != null) - (x.proratedFee != null) || y.spend - x.spend);
    totals.coverage = totals.proratedFee > 0 ? totals.spend / totals.proratedFee : null;

    // Aggregate crossover across all subscription agents (their spend vs the
    // combined flat fee). Metered/non-subscription spend is excluded.
    const subSpend = rows.reduce((s, r) => s + (r.proratedFee != null ? r.spend : 0), 0);
    totals.crossover = totals.subscriptions > 0
        ? crossoverFor(totals.monthlyFee, subSpend, days)
        : null;

    return { period, label, days, months, rows, totals };
}

// --- rendering ---------------------------------------------------------------

function fmtCost(c) {
    if (c == null) return '—';
    const neg = c < 0;
    const a = Math.abs(c);
    const s = a === 0 ? '$0.00' : a < 0.01 ? '<$0.01' : '$' + a.toFixed(2);
    return neg ? '-' + s : s;
}

function fmtDays(d) {
    if (d == null) return '—';
    if (!Number.isFinite(d)) return '∞';
    return d.toFixed(1) + 'd';
}

function crossoverLines(days, totals) {
    const x = totals.crossover;
    if (!x) return [];
    const verdict = x.verdict === 'flat'
        ? 'flat plan beats metered API at the current burn'
        : 'metered API would be cheaper at the current burn';
    const within = x.breakEvenDays != null && x.breakEvenDays <= AVG_MONTH_DAYS;
    const beTail = x.breakEvenDays == null
        ? ' (no usage)'
        : within
            ? ' — flat fee earned back inside a month'
            : ' — past a month, so metered would win';
    return [
        '',
        'Crossover (break-even) — combined subscriptions',
        '  burn          ' + fmtCost(x.dailyBurn) + '/day  ('
            + fmtCost(x.dailyBurn * days) + ' over ' + days + 'd)',
        '  crossover     ' + fmtCost(x.crossoverDaily) + '/day  '
            + '(metered == $' + x.monthlyFee.toFixed(2) + '/mo flat fee)',
        '  break-even    ' + fmtDays(x.breakEvenDays) + ' of usage to spend one month of fees'
            + beTail,
        '  → ' + verdict,
    ];
}

function renderSubsidy({ label, days, rows, totals }) {
    const headers = ['agent', 'plan', '$/mo', 'fee(' + days + 'd)', 'API spend', 'net subsidy', 'coverage'];
    const cell = (r) => [
        r.agent,
        r.plan || '—',
        r.monthlyFee == null ? '—' : fmtCost(r.monthlyFee),
        fmtCost(r.proratedFee),
        fmtCost(r.spend),
        fmtCost(r.net),
        r.coverage == null ? '—' : r.coverage.toFixed(1) + 'x',
    ];
    const lines = rows.map(cell);
    lines.push([
        'TOTAL', '', '', fmtCost(totals.proratedFee), fmtCost(totals.spend),
        fmtCost(totals.net), totals.coverage == null ? '—' : totals.coverage.toFixed(1) + 'x',
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    const fmt = (cells) => cells.map((c, i) =>
        i <= 1 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join('  ');

    const out = [];
    out.push('Subscription subsidy — ' + label);
    out.push('');
    out.push(fmt(headers));
    out.push(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const l of lines.slice(0, -1)) out.push(fmt(l));
    out.push(widths.map((w) => '-'.repeat(w)).join('  '));
    out.push(fmt(lines[lines.length - 1]));
    out.push('');
    out.push('net subsidy = API-equivalent spend − fee prorated to the period; '
        + 'coverage = spend ÷ prorated fee. Positive net = the flat plan beats metered API.');
    for (const l of crossoverLines(days, totals)) out.push(l);
    if (totals.subscriptions === 0) {
        out.push('(no subscription plan detected for any active agent — set fees with `tt subsidy --set`)');
    }
    return out.join('\n');
}

module.exports = {
    subsidy,
    renderSubsidy,
    detectPlans,
    loadConfig,
    saveConfig,
    SUBS_FILE,
    DEFAULT_FEES,
    PROVIDER_OF,
};
