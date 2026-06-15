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
// { added: { collectorName: count }, total, pricing }.
async function sync({ offline = false } = {}) {
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
    return { added, total: fresh.length, pricing };
}

module.exports = { sync, COLLECTORS };
