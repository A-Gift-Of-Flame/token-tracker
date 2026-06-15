'use strict';

// BL-106: recompute every stored record's cost against the current price table
// and rewrite the JSONL store in place. Pricing is the only mutable input —
// token counts, ids and timestamps are untouched, so a reprice is reversible by
// re-running against a different table. Full precision per record (rounding
// policy lives in pricing.js; display rounds, storage does not).
//
// Safety: a recompute against an offline/stale or empty table can zero out
// costs for models missing from the builtin fallback (e.g. non-Claude). So a
// real rewrite refuses unless pricing is live; --dry-run always previews and
// --force overrides the guard.

const store = require('./store');
const { getPricing, costFor } = require('./pricing');

async function reprice({ offline = false, dryRun = false, force = false } = {}) {
    const pricing = await getPricing({ offline });
    if (!dryRun && !force && !pricing.live) {
        return { aborted: true, pricing };
    }

    let records = 0;
    let changed = 0;
    let oldTotal = 0;
    let newTotal = 0;
    let nowPriced = 0;
    let lostPricing = 0;
    const files = store.listMonthFiles();

    for (const file of files) {
        const recs = store.readRecords(file);
        let fileChanged = false;
        for (const r of recs) {
            const { cost, priced } = costFor(pricing.table, r.model, r.provider, r);
            records++;
            oldTotal += r.cost || 0;
            newTotal += cost;
            if (cost !== r.cost || priced !== r.priced) {
                changed++;
                if (priced && !r.priced) nowPriced++;
                if (!priced && r.priced) lostPricing++;
                r.cost = cost;
                r.priced = priced;
                fileChanged = true;
            }
        }
        if (fileChanged && !dryRun) store.writeRecords(file, recs);
    }

    return {
        files: files.length, records, changed,
        oldTotal, newTotal, delta: newTotal - oldTotal,
        nowPriced, lostPricing, pricing, dryRun,
    };
}

module.exports = { reprice };
