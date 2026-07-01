'use strict';

// Live pricing from LiteLLM's community-maintained price table (covers
// Anthropic, OpenAI, Google, Mistral, and hundreds more, including cache
// rates). Cached locally for 24h; falls back to a built-in table for current
// Claude models, then to $0 (e.g. local ollama models are genuinely free).
//
// Rounding policy: costs are computed and stored at full double precision per
// record (no rounding at compute or store time). Rounding happens only at
// report display (report.js fmtCost / tt log's printout). Aggregations sum
// full-precision values first and round last.
//
// Cache-write tiers (Anthropic): 5m-TTL writes cost 1.25x base input, 1h-TTL
// writes cost 2x. Records may carry cacheWrite1h (the 1h portion of
// cacheWrite); the LiteLLM field for the 1h rate is
// cache_creation_input_token_cost_above_1hr, with inconsistent coverage —
// missing entries fall back to input * 2.

const { PRICING_FILE, readJson, writeJson } = require('./paths');

const SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Per-token USD. Cache write defaults to 1.25x input, cache read to 0.1x input.
const BUILTIN = {
    'claude-fable-5': { in: 10e-6, out: 50e-6 },
    'claude-mythos-5': { in: 10e-6, out: 50e-6 },
    'claude-opus-4-8': { in: 5e-6, out: 25e-6 },
    'claude-opus-4-7': { in: 5e-6, out: 25e-6 },
    'claude-opus-4-6': { in: 5e-6, out: 25e-6 },
    'claude-opus-4-5': { in: 5e-6, out: 25e-6 },
    'claude-sonnet-5': { in: 3e-6, out: 15e-6 },
    'claude-sonnet-4-6': { in: 3e-6, out: 15e-6 },
    'claude-sonnet-4-5': { in: 3e-6, out: 15e-6 },
    'claude-haiku-4-5': { in: 1e-6, out: 5e-6 },
};

async function fetchLive() {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('pricing fetch failed: HTTP ' + res.status);
    return res.json();
}

// Returns { table, fetchedAt, live }. Never throws — stale cache or builtin
// fallback on network failure.
async function getPricing({ refresh = false, offline = false } = {}) {
    const cached = readJson(PRICING_FILE, null);
    const fresh = cached && Date.now() - cached.fetchedAt < MAX_AGE_MS;
    if (cached && fresh && !refresh) {
        return { table: cached.table, fetchedAt: cached.fetchedAt, live: true };
    }
    if (!offline) {
        try {
            const table = await fetchLive();
            const fetchedAt = Date.now();
            writeJson(PRICING_FILE, { fetchedAt, table });
            return { table, fetchedAt, live: true };
        } catch { /* fall through to stale/builtin */ }
    }
    if (cached) return { table: cached.table, fetchedAt: cached.fetchedAt, live: false };
    return { table: {}, fetchedAt: 0, live: false };
}

function normalize(model) {
    return String(model || '').toLowerCase().trim();
}

// Find a pricing entry for a model name, trying exact and prefixed keys, then
// a date-suffix strip, then the longest prefix match.
function lookup(table, model, provider) {
    const m = normalize(model);
    if (!m) return null;
    const candidates = [m];
    if (provider) candidates.push(normalize(provider) + '/' + m);
    candidates.push('anthropic/' + m, 'openai/' + m, 'gemini/' + m);
    const stripped = m.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (stripped !== m) candidates.push(stripped, 'anthropic/' + stripped, 'openai/' + stripped);
    // Some tools (Copilot CLI) report version dots instead of dashes: "claude-haiku-4.5" → "claude-haiku-4-5"
    const dashed = m.replace(/(\d+)\.(\d+)/g, '$1-$2');
    if (dashed !== m) candidates.push(dashed, 'anthropic/' + dashed, 'openai/' + dashed);

    for (const c of candidates) {
        if (table[c] && table[c].input_cost_per_token != null) return table[c];
    }
    // Longest prefix match either direction (handles dated/variant keys)
    let best = null;
    let bestLen = 0;
    for (const key of Object.keys(table)) {
        const k = key.toLowerCase();
        const bare = k.includes('/') ? k.slice(k.indexOf('/') + 1) : k;
        if ((bare.startsWith(m) || m.startsWith(bare)) && bare.length > bestLen
            && table[key].input_cost_per_token != null) {
            best = table[key];
            bestLen = bare.length;
        }
    }
    return best;
}

function builtinLookup(model) {
    const m = normalize(model);
    const dashed = m.replace(/(\d+)\.(\d+)/g, '$1-$2');
    for (const key of Object.keys(BUILTIN)) {
        if (m.startsWith(key) || dashed.startsWith(key)) return BUILTIN[key];
    }
    return null;
}

// Providers that run models locally — always free, never matched against the
// hosted price table.
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'local', 'vllm']);

// Per-token rates for a model: { inC, outC, crC, cwC, cw1hC, priced }. Resolves
// the live table first, then the builtin Claude fallback. Local providers are
// genuinely free (priced, all-zero). priced=false when nothing matched.
function ratesFor(table, model, provider) {
    if (LOCAL_PROVIDERS.has(normalize(provider))) {
        return { inC: 0, outC: 0, crC: 0, cwC: 0, cw1hC: 0, priced: true };
    }
    const e = lookup(table, model, provider);
    if (e) {
        const inC = e.input_cost_per_token || 0;
        return {
            inC,
            outC: e.output_cost_per_token || 0,
            crC: e.cache_read_input_token_cost != null ? e.cache_read_input_token_cost : inC * 0.1,
            cwC: e.cache_creation_input_token_cost != null ? e.cache_creation_input_token_cost : inC * 1.25,
            cw1hC: e.cache_creation_input_token_cost_above_1hr != null
                ? e.cache_creation_input_token_cost_above_1hr : inC * 2,
            priced: true,
        };
    }
    const b = builtinLookup(model);
    if (b) {
        return { inC: b.in, outC: b.out, crC: b.in * 0.1, cwC: b.in * 1.25, cw1hC: b.in * 2, priced: true };
    }
    return { inC: 0, outC: 0, crC: 0, cwC: 0, cw1hC: 0, priced: false };
}

// rec: { input, output, cacheRead, cacheWrite, cacheWrite1h? }. cacheWrite is
// the TOTAL cache-write tokens; cacheWrite1h is the 1h-TTL portion (records
// without it are all-5m). Returns { cost, priced }.
function costFor(table, model, provider, rec) {
    const r = ratesFor(table, model, provider);
    if (!r.priced) return { cost: 0, priced: false };
    const cw = rec.cacheWrite || 0;
    const cw1h = Math.min(Math.max(rec.cacheWrite1h || 0, 0), cw);
    return {
        cost: rec.input * r.inC + rec.output * r.outC
            + (rec.cacheRead || 0) * r.crC + (cw - cw1h) * r.cwC + cw1h * r.cw1hC,
        priced: true,
    };
}

// BL-116: dollars saved by prompt caching vs a no-cache counterfactual where
// every cached token (read + write) would have been billed as fresh input.
// savings = counterfactual − actual cache cost. Positive when cheap reads
// dominate; can go negative if a record is write-heavy (writes cost >1x input).
// Returns 0 when the model has no known pricing (no basis to compare).
function cacheSavings(table, model, provider, rec) {
    const r = ratesFor(table, model, provider);
    if (!r.priced) return 0;
    const cw = rec.cacheWrite || 0;
    const cw1h = Math.min(Math.max(rec.cacheWrite1h || 0, 0), cw);
    const cr = rec.cacheRead || 0;
    const actual = cr * r.crC + (cw - cw1h) * r.cwC + cw1h * r.cw1hC;
    const counterfactual = (cr + cw) * r.inC;
    return counterfactual - actual;
}

module.exports = { getPricing, costFor, ratesFor, cacheSavings, SOURCE_URL };
