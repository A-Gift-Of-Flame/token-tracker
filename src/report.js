'use strict';

const store = require('./store');
const { cacheSavings } = require('./pricing');

// --- period helpers (local time) -------------------------------------------

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function periodRange(period, opts = {}) {
    const now = new Date();
    const today = startOfDay(now);
    if (opts.lastDays) {
        const n = Math.max(1, Math.floor(opts.lastDays));
        const from = new Date(today);
        from.setDate(today.getDate() - (n - 1));
        return { from, to: null, label: 'last ' + n + ' days (from ' + isoDate(from) + ')' };
    }
    switch (period) {
        case 'day':
        case 'today':
            return { from: today, to: null, label: 'today (' + isoDate(today) + ')' };
        case 'week': {
            const dow = (today.getDay() + 6) % 7; // Monday = 0
            const from = new Date(today);
            from.setDate(today.getDate() - dow);
            return { from, to: null, label: 'this week (from ' + isoDate(from) + ')' };
        }
        case 'month': {
            const from = new Date(today.getFullYear(), today.getMonth(), 1);
            return { from, to: null, label: 'this month (' + isoDate(from).slice(0, 7) + ')' };
        }
        case 'year': {
            const from = new Date(today.getFullYear(), 0, 1);
            return { from, to: null, label: 'this year (' + today.getFullYear() + ')' };
        }
        case 'all':
            return { from: null, to: null, label: 'all time' };
        default:
            throw new Error('unknown period: ' + period);
    }
}

function isoDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// --- aggregation ------------------------------------------------------------

function groupKey(r, by) {
    switch (by) {
        case 'agent': return r.agent;
        case 'model': return r.model;
        case 'agent-model': return r.agent + '  ' + r.model;
        case 'project': return r.project || '—'; // agents without project attribution
        case 'day': return isoDate(new Date(r.ts));
        case 'month': return isoDate(new Date(r.ts)).slice(0, 7);
        default: throw new Error('unknown grouping: ' + by);
    }
}

// Per-day cost/request series for the period. Gaps are zero-filled across the
// window when it has a bounded start within a year, so trends read true.
function buildTrend(records, from) {
    const days = new Map();
    for (const r of records) {
        const d = isoDate(new Date(r.ts));
        const e = days.get(d) || { day: d, cost: 0, requests: 0 };
        e.cost += r.cost || 0;
        e.requests += 1;
        days.set(d, e);
    }
    if (from) {
        const start = startOfDay(from);
        const today = startOfDay(new Date());
        const span = Math.round((today - start) / 86400000) + 1;
        if (span > 0 && span <= 366) {
            const series = [];
            for (let i = 0; i < span; i++) {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                const k = isoDate(d);
                series.push(days.get(k) || { day: k, cost: 0, requests: 0 });
            }
            return series;
        }
    }
    return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Fractional elapsed days vs full length for an ongoing calendar period. Used
// for run-rate forecasting. Returns null for periods with no fixed length
// (today/all) or rolling windows (--last).
function periodProgress(period, from, opts = {}) {
    if (opts.lastDays || !from) return null;
    const now = new Date();
    let totalDays;
    if (period === 'week') totalDays = 7;
    else if (period === 'month') totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    else if (period === 'year') {
        const y = now.getFullYear();
        totalDays = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
    } else return null;
    const elapsed = Math.max((now - startOfDay(from)) / 86400000, 1 / 24); // ≥1h to avoid div blow-up at period start
    return { elapsed, totalDays };
}

// Range of the period immediately before the current one (same length). The
// current period runs [from, now); the prior is the full bounded window ending
// where the current one starts. Returns null when there is no fixed prior
// (all time). Powers `--vs last` (BL-115).
function priorRange(period, from, opts = {}) {
    if (!from) return null; // all time
    if (opts.lastDays) {
        const n = Math.max(1, Math.floor(opts.lastDays));
        const to = startOfDay(from);
        const pfrom = new Date(to);
        pfrom.setDate(to.getDate() - n);
        return { from: pfrom, to, label: 'prior ' + n + ' days' };
    }
    switch (period) {
        case 'day':
        case 'today': {
            const to = startOfDay(from);
            const pfrom = new Date(to);
            pfrom.setDate(to.getDate() - 1);
            return { from: pfrom, to, label: 'yesterday' };
        }
        case 'week': {
            const pfrom = new Date(from);
            pfrom.setDate(from.getDate() - 7);
            return { from: pfrom, to: new Date(from), label: 'last week' };
        }
        case 'month': {
            const pfrom = new Date(from.getFullYear(), from.getMonth() - 1, 1);
            return { from: pfrom, to: new Date(from), label: 'last month' };
        }
        case 'year': {
            const pfrom = new Date(from.getFullYear() - 1, 0, 1);
            return { from: pfrom, to: new Date(from), label: 'last year' };
        }
        default: return null;
    }
}

function sumTotals(records) {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
    for (const r of records) {
        t.input += r.input;
        t.output += r.output;
        t.cacheRead += r.cacheRead || 0;
        t.cacheWrite += r.cacheWrite || 0;
        t.cost += r.cost || 0;
        t.requests += 1;
    }
    return t;
}

// BL-116: derived efficiency KPIs from period totals. cacheSaved is summed
// per-record (rates vary by model) and passed in; null when no price table is
// available. cost/output and cache-hit are pure ratios over the totals.
function computeEfficiency(total, cacheSaved) {
    const prompt = total.input + total.cacheRead + total.cacheWrite;
    return {
        costPerMOutput: total.output > 0 ? total.cost / total.output * 1e6 : null,
        cacheHitRate: prompt > 0 ? total.cacheRead / prompt : null,
        cacheSaved, // dollars; null when pricing unavailable
    };
}

const CMP_METRICS = ['cost', 'requests', 'input', 'output', 'cacheRead', 'cacheWrite'];

// Per-metric absolute delta + percent change (null pct when the prior was 0).
function computeDeltas(cur, prev) {
    const out = {};
    for (const m of CMP_METRICS) {
        const abs = (cur[m] || 0) - (prev[m] || 0);
        out[m] = { cur: cur[m] || 0, prev: prev[m] || 0, abs, pct: prev[m] ? abs / prev[m] * 100 : null };
    }
    return out;
}

function report(period, by, opts = {}) {
    const { from, to, label } = periodRange(period, opts);
    const records = store.loadRange(from ? from.toISOString() : null, to ? to.toISOString() : null);
    const groups = new Map();
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0, unpriced: 0 };
    const table = opts.efficiency ? opts.pricingTable : null;
    let cacheSaved = table ? 0 : null;
    for (const r of records) {
        const key = groupKey(r, by);
        if (!groups.has(key)) {
            groups.set(key, { key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0, unpriced: 0 });
        }
        for (const g of [groups.get(key), total]) {
            g.input += r.input;
            g.output += r.output;
            g.cacheRead += r.cacheRead || 0;
            g.cacheWrite += r.cacheWrite || 0;
            g.cost += r.cost || 0;
            g.requests += 1;
            if (r.priced === false) g.unpriced += 1;
        }
        if (table) cacheSaved += cacheSavings(table, r.model, r.provider, r);
    }
    const rows = [...groups.values()].sort((a, b) =>
        by === 'day' || by === 'month' ? (a.key < b.key ? -1 : 1) : b.cost - a.cost || b.output - a.output);
    const result = { label, rows, total };
    if (opts.efficiency) result.efficiency = computeEfficiency(total, cacheSaved);
    if (opts.trend) result.trend = buildTrend(records, from);
    if (opts.forecast) {
        const prog = periodProgress(period, from, opts);
        if (prog) result.forecast = { projected: total.cost / prog.elapsed * prog.totalDays, ...prog };
    }
    if (opts.vsLast) {
        const prior = priorRange(period, from, opts);
        if (prior) {
            const precs = store.loadRange(prior.from.toISOString(), prior.to.toISOString());
            result.comparison = { label: prior.label, deltas: computeDeltas(total, sumTotals(precs)) };
        }
    }
    return result;
}

// --- rendering ---------------------------------------------------------------

function fmtNum(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function fmtCost(c) {
    if (c === 0) return '$0.00';
    if (c < 0.01) return '<$0.01';
    return '$' + c.toFixed(2);
}

function sparkline(values) {
    const blocks = '▁▂▃▄▅▆▇█';
    const max = Math.max(0, ...values);
    return values.map((v) => {
        if (max <= 0) return blocks[0];
        const idx = Math.min(blocks.length - 1, Math.max(0, Math.round((v / max) * (blocks.length - 1))));
        return blocks[idx];
    }).join('');
}

function renderTrend(trend) {
    const out = [''];
    out.push('Daily cost trend (' + trend.length + ' days):');
    out.push('  ' + sparkline(trend.map((t) => t.cost)));
    const peak = trend.reduce((a, b) => (b.cost > a.cost ? b : a), trend[0]);
    out.push('  ' + trend[0].day + ' → ' + trend[trend.length - 1].day
        + '   peak ' + peak.day + ' ' + fmtCost(peak.cost));
    return out.join('\n');
}

// Budget "% consumed" (BL-105) + run-rate forecast vs budget (BL-113). Budget
// is a monthly figure, so the consumed line shows only on the month report;
// the forecast line shows on any period with a projection.
function renderBudgetForecast(total, forecast, opts) {
    const out = [];
    const monthly = opts.budget;
    const onMonth = opts.period === 'month' && monthly > 0;
    if (onMonth) {
        const pct = total.cost / monthly * 100;
        out.push('Budget: ' + fmtCost(total.cost) + ' / ' + fmtCost(monthly)
            + ' (' + pct.toFixed(0) + '% consumed)');
    }
    if (forecast) {
        let line = 'Forecast: ' + fmtCost(forecast.projected) + ' by period end'
            + ' (' + forecast.elapsed.toFixed(1) + ' of ' + forecast.totalDays + ' days elapsed)';
        if (onMonth) {
            const fpct = forecast.projected / monthly * 100;
            line += ' — ' + fpct.toFixed(0) + '% of budget'
                + (forecast.projected > monthly ? ', OVER by ' + fmtCost(forecast.projected - monthly) : '');
        }
        out.push(line);
    }
    return out.length ? '\n' + out.join('\n') : '';
}

// BL-116 efficiency block. cacheSaved omitted with a note when no price table.
function renderEfficiency(eff) {
    const out = ['', 'Efficiency:'];
    out.push('  $/M output:    ' + (eff.costPerMOutput === null ? '—' : '$' + eff.costPerMOutput.toFixed(2)));
    out.push('  cache hit:     ' + (eff.cacheHitRate === null ? '—' : (eff.cacheHitRate * 100).toFixed(1) + '%'));
    if (eff.cacheSaved === null) {
        out.push('  cache savings: — (run online for pricing)');
    } else {
        out.push('  cache savings: ' + (eff.cacheSaved < 0 ? '-' : '') + fmtCost(Math.abs(eff.cacheSaved))
            + ' vs no-cache');
    }
    return out.join('\n');
}

function cmpVal(m, v) {
    return m === 'cost' ? fmtCost(v) : m === 'requests' ? String(v) : fmtNum(v);
}

function renderComparison(cmp) {
    const out = ['', 'Compared to ' + cmp.label + ':'];
    const rows = CMP_METRICS.map((m) => {
        const d = cmp.deltas[m];
        const pct = d.pct === null ? (d.cur > 0 ? 'new' : '—') : (d.pct >= 0 ? '+' : '') + d.pct.toFixed(1) + '%';
        const delta = (d.abs < 0 ? '-' : '+') + cmpVal(m, Math.abs(d.abs));
        return [m, cmpVal(m, d.cur), cmpVal(m, d.prev), delta, '(' + pct + ')'];
    });
    const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
    for (const r of rows) {
        out.push('  ' + r[0].padEnd(w[0]) + '  ' + r[1].padStart(w[1])
            + '  vs ' + r[2].padStart(w[2]) + '   ' + r[3].padStart(w[3]) + '  ' + r[4]);
    }
    return out.join('\n');
}

function render({ label, rows, total, trend, forecast, comparison, efficiency }, by, opts = {}) {
    const compact = !!(opts && opts.compact);
    const rowCells = (g) => compact
        ? [g.key, String(g.requests), fmtCost(g.cost)]
        : [g.key, String(g.requests), fmtNum(g.input), fmtNum(g.output),
            fmtNum(g.cacheRead), fmtNum(g.cacheWrite), fmtCost(g.cost)];
    const headers = compact
        ? [by, 'reqs', 'cost']
        : [by, 'reqs', 'input', 'output', 'cache r', 'cache w', 'cost'];
    const lines = rows.map(rowCells);
    lines.push(rowCells({ ...total, key: 'TOTAL' }));
    const widths = headers.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    const fmt = (cells) => cells.map((c, i) =>
        i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join('  ');

    const out = [];
    out.push('Token usage — ' + label);
    out.push('');
    out.push(fmt(headers));
    out.push(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const l of lines.slice(0, -1)) out.push(fmt(l));
    out.push(widths.map((w) => '-'.repeat(w)).join('  '));
    out.push(fmt(lines[lines.length - 1]));
    if (total.unpriced > 0) {
        out.push('');
        out.push('(' + total.unpriced + ' requests had no known pricing — counted at $0, e.g. local models)');
    }
    const bf = renderBudgetForecast(total, forecast, opts);
    if (bf) out.push(bf);
    if (efficiency) out.push(renderEfficiency(efficiency));
    if (comparison) out.push(renderComparison(comparison));
    if (trend && trend.length) out.push(renderTrend(trend));
    return out.join('\n');
}

module.exports = { report, render, periodRange };
