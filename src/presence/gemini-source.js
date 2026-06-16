'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PRICING_FILE, readJson } = require('../paths');
const { costFor } = require('../pricing');
const { DEFAULT_FRESHNESS_MS } = require('./source');
const { sessionFiles } = require('../collectors/gemini-cli');

const DEFAULT_POLL_MS = 1000;
const MAX_PARSE_BYTES = 8 * 1024 * 1024;

function geminiRoot(home = os.homedir()) {
    return path.join(home, '.gemini');
}

function newestSession(root = geminiRoot(), fsObj = fs) {
    let best = null;
    for (const file of sessionFiles(root)) {
        let st;
        try { st = fsObj.statSync(file); } catch { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs, size: st.size };
    }
    return best;
}

function completeJsonlEntries(file, fsObj = fs, maxBytes = MAX_PARSE_BYTES) {
    let st;
    try { st = fsObj.statSync(file); } catch { return []; }
    if (st.size > maxBytes) return [];
    let text;
    try { text = fsObj.readFileSync(file, 'utf8'); } catch { return []; }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return [];
    const out = [];
    for (const line of text.slice(0, lastNl).split('\n')) {
        if (!line || !line.includes('"gemini"')) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed complete line */ }
    }
    return out;
}

function loadPricingTable(opts = {}) {
    if (opts.pricingTable) return opts.pricingTable;
    const cached = readJson(opts.pricingFile || PRICING_FILE, null);
    return (cached && cached.table) || {};
}

function usageFromGeminiLine(e) {
    if (!e || e.type !== 'gemini' || !e.tokens) return null;
    const t = e.tokens;
    if (!(t.input || t.output || t.cached || t.thoughts || t.tool)) return null;
    return {
        input: Number(t.input || 0) + Number(t.tool || 0),
        output: Number(t.output || 0) + Number(t.thoughts || 0),
        cacheRead: Number(t.cached || 0),
        cacheWrite: 0,
    };
}

function normalizeGeminiSession(session, entries, opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
    const project = session && session.file ? path.basename(path.dirname(path.dirname(session.file))) : null;
    if (!session || !entries.length) {
        const missing = [];
        if (!project) missing.push('project');
        missing.push('model', 'activity', 'tokens', 'cost');
        return {
            status: 'idle',
            source: 'gemini-session-tail',
            ceiling: 'gemini-cli-live-tail',
            agent: 'gemini-cli',
            project,
            model: null,
            activity: null,
            tokens: null,
            cost: null,
            timestamps: { startedAt: null, lastActivityAt: null, observedAt: new Date(now).toISOString() },
            missing,
        };
    }

    let model = null;
    let firstTs = null;
    let lastTs = null;
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let turns = 0;
    let costAmount = 0;
    let priced = false;
    const pricingTable = loadPricingTable(opts);

    for (const e of entries) {
        if (e.timestamp) {
            const t = Date.parse(e.timestamp);
            if (Number.isFinite(t)) {
                if (firstTs === null) firstTs = t;
                lastTs = t;
            }
        }
        if (e.model) model = e.model;
        const usage = usageFromGeminiLine(e);
        if (!usage) continue;
        turns++;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        const pricedCost = costFor(pricingTable, e.model || model, 'gemini', usage);
        costAmount += pricedCost.cost;
        priced = priced || pricedCost.priced;
    }

    const lastMs = lastTs || session.mtimeMs || now;
    const missing = [];
    if (!project) missing.push('project');
    if (!model) missing.push('model');
    missing.push('activity');
    if (!turns) missing.push('tokens');
    if (!priced) missing.push('cost');

    return {
        status: now - lastMs <= freshnessMs ? 'active' : 'stale',
        source: 'gemini-session-tail',
        ceiling: 'gemini-cli-live-tail',
        agent: 'gemini-cli',
        project,
        model,
        activity: null,
        tokens: turns ? totals : null,
        cost: priced ? {
            amount: costAmount,
            currency: 'USD',
            estimated: true,
            estimateFlag: true,
            exact: false,
            exactFlag: false,
        } : null,
        timestamps: {
            startedAt: firstTs === null ? null : new Date(firstTs).toISOString(),
            lastActivityAt: new Date(lastMs).toISOString(),
            observedAt: new Date(now).toISOString(),
        },
        missing,
    };
}

function readGeminiPresenceState(opts = {}) {
    const fsObj = opts.fs || fs;
    const session = opts.file
        ? (() => {
            try {
                const st = fsObj.statSync(opts.file);
                return { file: opts.file, mtimeMs: st.mtimeMs, size: st.size };
            } catch { return null; }
        })()
        : newestSession(opts.geminiRoot || geminiRoot(opts.home), fsObj);
    const entries = session ? completeJsonlEntries(session.file, fsObj, opts.maxParseBytes || MAX_PARSE_BYTES) : [];
    return normalizeGeminiSession(session, entries, opts);
}

class GeminiSessionPresenceSource extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.opts = opts;
        this.pollMs = opts.pollMs || DEFAULT_POLL_MS;
        this.timer = null;
        this.lastSignature = null;
        this.latestState = null;
    }

    start() {
        this.poll();
        this.timer = setInterval(() => this.poll(), this.pollMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    poll() {
        const state = readGeminiPresenceState(this.opts);
        this.latestState = state;
        const sig = JSON.stringify(state);
        if (sig === this.lastSignature) return;
        this.lastSignature = sig;
        this.emit('state', state);
    }
}

module.exports = {
    DEFAULT_POLL_MS,
    MAX_PARSE_BYTES,
    GeminiSessionPresenceSource,
    completeJsonlEntries,
    geminiRoot,
    newestSession,
    normalizeGeminiSession,
    readGeminiPresenceState,
    usageFromGeminiLine,
};
