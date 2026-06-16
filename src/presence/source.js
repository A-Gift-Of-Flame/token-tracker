'use strict';

const EventEmitter = require('events');
const store = require('../store');

const DEFAULT_POLL_MS = 5000;
const DEFAULT_FRESHNESS_MS = 2 * 60 * 1000;

function latestRecord(records) {
    let latest = null;
    for (const rec of records) {
        if (!rec || !rec.ts) continue;
        if (!latest || rec.ts > latest.ts) latest = rec;
    }
    return latest;
}

function normalizeRecord(rec, opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
    if (!rec) {
        return {
            status: 'idle',
            missing: ['agent', 'project', 'model', 'tokens', 'cost'],
            timestamps: { observedAt: new Date(now).toISOString() },
        };
    }
    const last = Date.parse(rec.ts);
    const ageMs = Number.isFinite(last) ? now - last : Infinity;
    const missing = [];
    if (!rec.agent) missing.push('agent');
    if (!rec.project) missing.push('project');
    if (!rec.model) missing.push('model');
    const hasTokens = ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => Number.isFinite(rec[k]));
    if (!hasTokens) missing.push('tokens');
    const hasCost = rec.priced !== false && Number.isFinite(rec.cost);
    if (!hasCost) missing.push('cost');
    return {
        status: ageMs <= freshnessMs ? 'fresh' : 'stale',
        source: 'store-latest',
        ceiling: 'foreground-store',
        agent: rec.agent || null,
        project: rec.project || null,
        model: rec.model || null,
        activity: 'latest stored request',
        tokens: hasTokens ? {
            input: Number(rec.input || 0),
            output: Number(rec.output || 0),
            cacheRead: Number(rec.cacheRead || 0),
            cacheWrite: Number(rec.cacheWrite || 0),
        } : null,
        cost: hasCost ? {
            amount: Number(rec.cost),
            currency: 'USD',
            exact: true,
            exactFlag: true,
            estimated: false,
            estimateFlag: false,
        } : null,
        timestamps: {
            lastActivityAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
            observedAt: new Date(now).toISOString(),
        },
        missing,
    };
}

class StorePresenceSource extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.pollMs = opts.pollMs || DEFAULT_POLL_MS;
        this.freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
        this.store = opts.store || store;
        this.timer = null;
        this.lastSignature = null;
    }

    start() {
        this.poll();
        this.timer = setInterval(() => this.poll(), this.pollMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    poll() {
        let state;
        try {
            // Only the newest month file can hold the global max-ts record (append
            // keys each record into its ts's month file), so scan just that file
            // instead of re-reading the whole ledger every poll.
            const files = this.store.listMonthFiles();
            const recs = files.length ? this.store.readRecords(files[files.length - 1]) : [];
            const rec = latestRecord(recs);
            state = normalizeRecord(rec, { freshnessMs: this.freshnessMs });
        } catch (err) {
            state = {
                status: 'idle',
                source: 'store-latest',
                error: err && err.message ? err.message : String(err),
                missing: ['agent', 'project', 'model', 'tokens', 'cost'],
                timestamps: { observedAt: new Date().toISOString() },
            };
        }
        const sig = JSON.stringify(state);
        if (sig === this.lastSignature) return;
        this.lastSignature = sig;
        this.emit('state', state);
    }
}

module.exports = {
    DEFAULT_FRESHNESS_MS,
    DEFAULT_POLL_MS,
    StorePresenceSource,
    latestRecord,
    normalizeRecord,
};
