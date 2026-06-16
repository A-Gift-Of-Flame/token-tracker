'use strict';

const DEFAULT_FRESHNESS_MS = 2 * 60 * 1000;

function truncate(s, n = 128) {
    s = String(s);
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function ageLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    const min = Math.round(sec / 60);
    if (min < 60) return min + 'm';
    const hr = Math.round(min / 60);
    if (hr < 48) return hr + 'h';
    return Math.round(hr / 24) + 'd';
}

function shortNumber(n) {
    if (!Number.isFinite(n)) return null;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
}

function formatCost(cost) {
    if (!cost || !Number.isFinite(cost.amount)) return 'cost missing';
    const amount = Math.abs(cost.amount);
    let value;
    if (amount === 0) value = '$0.00';
    else if (amount < 0.01) value = '<$0.01';
    else value = '$' + amount.toFixed(2);
    if (cost.amount < 0) value = '-' + value;
    if (cost.estimated || cost.estimateFlag) return value + ' est';
    if (cost.exact || cost.exactFlag) return value + ' exact';
    return value + ' unlabelled';
}

function tokenTotal(tokens) {
    if (!tokens) return null;
    const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
    let seen = false;
    let total = 0;
    for (const field of fields) {
        if (Number.isFinite(tokens[field])) {
            seen = true;
            total += tokens[field];
        }
    }
    return seen ? total : null;
}

function missingSet(state) {
    const out = new Set(Array.isArray(state && state.missing) ? state.missing : []);
    if (!state || !state.agent) out.add('agent');
    if (!state || !state.project) out.add('project');
    if (!state || !state.model) out.add('model');
    if (tokenTotal(state && state.tokens) === null) out.add('tokens');
    if (!state || !state.cost || !Number.isFinite(state.cost.amount)) out.add('cost');
    return out;
}

function renderPresenceActivity(state, opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
    if (!state || state.status === 'idle') {
        return {
            details: 'token-tracker idle',
            state: 'no usage records found',
            timestamps: { start: Math.floor(now / 1000) },
        };
    }

    const last = state.timestamps && state.timestamps.lastActivityAt
        ? Date.parse(state.timestamps.lastActivityAt)
        : NaN;
    const ageMs = Number.isFinite(last) ? now - last : Infinity;
    const fresh = state.status !== 'stale'
        && (state.status === 'fresh' || state.status === 'active' || ageMs <= freshnessMs);
    const missing = missingSet(state);
    const agent = state.agent || 'agent missing';
    const project = state.project || 'project missing';
    const model = state.model || 'model missing';
    const tokens = tokenTotal(state.tokens);

    const details = fresh
        ? agent + ' recent · ' + project
        : agent + ' idle · stale ' + ageLabel(ageMs) + ' ago';

    const parts = [];
    if (!fresh) parts.push('stale');
    if (state.activity) parts.push(String(state.activity));
    parts.push(model);
    parts.push(tokens === null ? 'tokens missing' : shortNumber(tokens) + ' tok');
    parts.push(formatCost(state.cost));
    for (const field of missing) {
        const label = field + ' missing';
        if (!parts.includes(label) && (field === 'project' || field === 'model')) parts.push(label);
    }

    const activity = {
        details: truncate(details),
        state: truncate(parts.join(' · ')),
        timestamps: { start: Math.floor((Number.isFinite(last) ? last : now) / 1000) },
    };
    if (state.assets) activity.assets = state.assets;
    return activity;
}

function backgroundCost(states) {
    let amount = 0;
    let seen = false;
    let exact = true;
    for (const state of states) {
        const cost = state && state.cost;
        if (!cost || !Number.isFinite(cost.amount)) {
            exact = false;
            continue;
        }
        seen = true;
        amount += cost.amount;
        if (cost.estimated || cost.estimateFlag || (!cost.exact && !cost.exactFlag)) exact = false;
    }
    if (!seen) return null;
    return {
        amount,
        currency: 'USD',
        exact,
        exactFlag: exact,
        estimated: !exact,
        estimateFlag: !exact,
    };
}

function backgroundTokens(states) {
    let total = 0;
    let seen = false;
    for (const state of states) {
        const tokens = tokenTotal(state && state.tokens);
        if (tokens === null) continue;
        seen = true;
        total += tokens;
    }
    return seen ? total : null;
}

function renderMultiplexActivity(combined, opts = {}) {
    if (!combined || combined.status === 'idle' || !combined.headline) {
        return renderPresenceActivity({ status: 'idle' }, opts);
    }
    const activity = renderPresenceActivity(combined.headline, opts);
    const background = Array.isArray(combined.background) ? combined.background : [];
    if (!background.length) return activity;

    const tokens = backgroundTokens(background);
    const tail = '+' + background.length + ' bg'
        + ' · ' + formatCost(backgroundCost(background))
        + ' · ' + (tokens === null ? 'tokens missing' : shortNumber(tokens) + ' tok');
    const suffix = ' · ' + tail;
    activity.state = truncate(
        truncate(activity.state, Math.max(1, 128 - suffix.length)) + suffix
    );
    return activity;
}

module.exports = {
    DEFAULT_FRESHNESS_MS,
    ageLabel,
    formatCost,
    renderMultiplexActivity,
    renderPresenceActivity,
    shortNumber,
};
