'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PRICING_FILE, readJson } = require('../paths');
const { costFor } = require('../pricing');
const { DEFAULT_FRESHNESS_MS } = require('./source');
const { toolLabel } = require('./claude-source');

const DEFAULT_POLL_MS = 1000;
const MAX_PARSE_BYTES = 8 * 1024 * 1024;

function codexSessionsDir(home = os.homedir()) {
    return path.join(home, '.codex', 'sessions');
}

function newestRollout(sessionsDir, fsObj = fs) {
    let best = null;
    const walk = (dir) => {
        let entries;
        try { entries = fsObj.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (e.name.endsWith('.jsonl')) {
                let st;
                try { st = fsObj.statSync(p); } catch { continue; }
                if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: st.mtimeMs, size: st.size };
            }
        }
    };
    walk(sessionsDir);
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
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed complete line */ }
    }
    return out;
}

function loadPricingTable(opts = {}) {
    if (opts.pricingTable) return opts.pricingTable;
    const cached = readJson(opts.pricingFile || PRICING_FILE, null);
    return (cached && cached.table) || {};
}

function usageFromTokenCount(e) {
    const p = (e && e.payload) || {};
    if (e.type !== 'event_msg' || p.type !== 'token_count') return null;
    const u = (p.info && p.info.last_token_usage) || null;
    if (!u) return null;
    const cached = Number(u.cached_input_tokens || 0);
    return {
        input: Math.max(0, Number(u.input_tokens || 0) - cached),
        output: Number(u.output_tokens || 0),
        cacheRead: cached,
        cacheWrite: 0,
    };
}

function activityFromResponseItem(e) {
    const p = (e && e.payload) || {};
    if (e.type !== 'response_item') return null;
    if (p.type === 'function_call' && p.name) return 'Using ' + toolLabel(p.name);
    if (p.type === 'reasoning') return 'Reasoning';
    return null;
}

function normalizeCodexRollout(rollout, entries, opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
    if (!rollout || !entries.length) {
        return {
            status: 'idle',
            source: 'codex-rollout-tail',
            ceiling: 'codex-live-tail',
            agent: 'codex',
            project: null,
            model: null,
            activity: null,
            tokens: null,
            cost: null,
            timestamps: { startedAt: null, lastActivityAt: null, observedAt: new Date(now).toISOString() },
            missing: ['project', 'model', 'activity', 'tokens', 'cost'],
        };
    }

    let cwd = null;
    let model = null;
    let firstTs = null;
    let lastTs = null;
    let activity = null;
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let turns = 0;
    let costAmount = 0;
    let priced = false;
    const pricingTable = loadPricingTable(opts);

    for (const e of entries) {
        const p = e.payload || {};
        if (e.timestamp) {
            const t = Date.parse(e.timestamp);
            if (Number.isFinite(t)) {
                if (firstTs === null) firstTs = t;
                lastTs = t;
            }
        }
        if ((e.type === 'turn_context' || e.type === 'session_meta') && p.cwd) cwd = p.cwd;
        if ((e.type === 'turn_context' || e.type === 'session_meta') && p.model) model = p.model;

        const nextActivity = activityFromResponseItem(e);
        if (nextActivity) activity = nextActivity;

        const usage = usageFromTokenCount(e);
        if (!usage) continue;
        turns++;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        const pricedCost = costFor(pricingTable, model || 'gpt-5', 'openai', usage);
        costAmount += pricedCost.cost;
        priced = priced || pricedCost.priced;
    }

    const lastMs = lastTs || rollout.mtimeMs || now;
    const project = cwd ? path.basename(String(cwd)) : null;
    const missing = [];
    if (!project) missing.push('project');
    if (!model) missing.push('model');
    if (!activity) missing.push('activity');
    if (!turns) missing.push('tokens');
    if (!priced) missing.push('cost');

    return {
        status: now - lastMs <= freshnessMs ? 'active' : 'stale',
        source: 'codex-rollout-tail',
        ceiling: 'codex-live-tail',
        agent: 'codex',
        project,
        model,
        activity,
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

function readCodexPresenceState(opts = {}) {
    const fsObj = opts.fs || fs;
    const rollout = opts.file
        ? (() => {
            try {
                const st = fsObj.statSync(opts.file);
                return { file: opts.file, mtimeMs: st.mtimeMs, size: st.size };
            } catch { return null; }
        })()
        : newestRollout(opts.sessionsDir || codexSessionsDir(opts.home), fsObj);
    const entries = rollout ? completeJsonlEntries(rollout.file, fsObj, opts.maxParseBytes || MAX_PARSE_BYTES) : [];
    return normalizeCodexRollout(rollout, entries, opts);
}

class CodexRolloutPresenceSource extends EventEmitter {
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
        const state = readCodexPresenceState(this.opts);
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
    CodexRolloutPresenceSource,
    activityFromResponseItem,
    codexSessionsDir,
    completeJsonlEntries,
    newestRollout,
    normalizeCodexRollout,
    readCodexPresenceState,
    usageFromTokenCount,
};
