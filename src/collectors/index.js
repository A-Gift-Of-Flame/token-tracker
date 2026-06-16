'use strict';

const store = require('../store');
const { getPricing, costFor } = require('../pricing');

const COLLECTORS = [
    require('./claude-code'),
    require('./codex'),
    require('./opencode'),
    require('./gemini-cli'),
    require('./copilot-cli'),
    require('./cursor'),
    require('./dropbox'),
];

// Run all collectors, price new records, append to store. Returns
// { added: { collectorName: count }, total, pricing, push?, pushError? }.
//
// push is tri-state: true forces a remote push, false suppresses it, undefined
// (default) pushes when remote.json has autoPush on AND this ingest produced new
// records. Centralizing the push here means EVERY ingest path — `tt sync`, the
// auto-sync inside `tt serve`, and reports that sync first — pushes to the VPS,
// not just the CLI sync command. Push failure never breaks ingest: the error is
// returned as pushError and the high-water mark stays put so the next sync retries.
async function sync({ offline = false, push } = {}) {
    const pricing = await getPricing({ offline });
    const state = store.loadState();
    const seen = store.loadIds();
    const added = {};
    const fresh = [];

    for (const c of COLLECTORS) {
        const cState = state.collectors[c.name] || (state.collectors[c.name] = {});
        let recs = [];
        try { recs = c.collect(cState); } catch { /* collector unavailable */ }
        let n = 0;
        for (const r of recs) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            const { cost, priced } = costFor(pricing.table, r.model, r.provider, r);
            fresh.push({ ...r, cost, priced });
            n++;
        }
        added[c.name] = n;
    }

    if (fresh.length) store.append(fresh);
    store.saveState(state);

    const result = { added, total: fresh.length, pricing };

    // Push to the VPS at ingest. Lazy-require avoids a load cycle and keeps the
    // collector pipeline usable without a remote configured.
    if (push !== false) {
        const remote = require('../remote');
        const cfg = remote.loadRemote();
        const wantPush = push === true || (fresh.length > 0 && cfg && cfg.autoPush);
        if (wantPush && cfg) {
            try {
                result.push = await remote.push();
            } catch (err) {
                result.pushError = err && err.message ? err.message : String(err);
            }
        }
    }

    return result;
}

module.exports = { sync, COLLECTORS };
