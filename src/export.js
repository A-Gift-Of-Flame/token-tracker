'use strict';

// BL-118: export records or an aggregated report as CSV/Markdown for
// spreadsheets/sharing. Read-only over the JSONL store — never mutates.
// Cost is rounded to 6 decimals to drop float dust while staying well below
// display rounding (the report still rounds to cents; this is for sheets).

const store = require('./store');
const { report, periodRange } = require('./report');

function money(c) {
    return Number((c || 0).toFixed(6));
}

// Aggregated report rows (same grouping as `tt <period> --by`), plus a TOTAL.
function aggregate(period, by, opts = {}) {
    const r = report(period, by, opts);
    const headers = [by, 'requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost'];
    const rows = r.rows.map((g) => [g.key, g.requests, g.input, g.output, g.cacheRead, g.cacheWrite, money(g.cost)]);
    rows.push(['TOTAL', r.total.requests, r.total.input, r.total.output, r.total.cacheRead, r.total.cacheWrite, money(r.total.cost)]);
    return { headers, rows, label: r.label };
}

// Raw records in the period, oldest first.
function records(period, opts = {}) {
    const { from, to, label } = periodRange(period, opts);
    const recs = store.loadRange(from ? from.toISOString() : null, to ? to.toISOString() : null)
        .sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const headers = ['ts', 'agent', 'model', 'provider', 'project', 'input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'priced', 'id'];
    const rows = recs.map((r) => headers.map((h) => {
        if (h === 'cost') return money(r.cost);
        return r[h] === undefined ? '' : r[h];
    }));
    return { headers, rows, label };
}

// BL-119: lossless ledger — raw store records, oldest first, full fidelity
// (no rounding, every field including cacheWrite1h/priced). Round-trips through
// `tt import`. Distinct from records() which rounds cost for spreadsheets.
function ledger(period, opts = {}) {
    const { from, to } = periodRange(period, opts);
    return store.loadRange(from ? from.toISOString() : null, to ? to.toISOString() : null)
        .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

function toJsonl(records) {
    return records.map((r) => JSON.stringify(r)).join('\n');
}

function csvCell(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv({ headers, rows }) {
    return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

function mdCell(v) {
    return String(v).replace(/\|/g, '\\|');
}

function toMd({ headers, rows }) {
    const h = '| ' + headers.map(mdCell).join(' | ') + ' |';
    const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
    const body = rows.map((r) => '| ' + r.map(mdCell).join(' | ') + ' |').join('\n');
    return body ? [h, sep, body].join('\n') : [h, sep].join('\n');
}

module.exports = { aggregate, records, ledger, toCsv, toMd, toJsonl };
