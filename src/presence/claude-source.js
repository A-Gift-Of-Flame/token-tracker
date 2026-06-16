'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PRICING_FILE, readJson } = require('../paths');
const { costFor } = require('../pricing');
const { DEFAULT_FRESHNESS_MS } = require('./source');

const DEFAULT_POLL_MS = 1000;
const MAX_PARSE_BYTES = 8 * 1024 * 1024;

function toolLabel(name) {
    let label = String(name || '');
    if (label.startsWith('mcp__')) label = label.split('__').pop();
    return label.length > 24 ? label.slice(0, 23) + '...' : label;
}

function claudeProjectsDir(home = os.homedir()) {
    return path.join(home, '.claude', 'projects');
}

function newestTranscript(projectsDir, fsObj = fs) {
    let best = null;
    let dirs;
    try { dirs = fsObj.readdirSync(projectsDir); } catch { return null; }
    for (const d of dirs) {
        const dir = path.join(projectsDir, d);
        let files;
        try { files = fsObj.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const file = path.join(dir, f);
            let st;
            try { st = fsObj.statSync(file); } catch { continue; }
            if (!best || st.mtimeMs > best.mtimeMs) {
                best = { file, mtimeMs: st.mtimeMs, size: st.size };
            }
        }
    }
    return best;
}

function parseJsonlFile(file, fsObj = fs, maxBytes = MAX_PARSE_BYTES) {
    let st;
    try { st = fsObj.statSync(file); } catch { return []; }
    if (st.size > maxBytes) return [];
    let text;
    try { text = fsObj.readFileSync(file, 'utf8'); } catch { return []; }
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return [];
    return text.slice(0, lastNl).split('\n')
        .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
}

function loadPricingTable(opts = {}) {
    if (opts.pricingTable) return opts.pricingTable;
    const cached = readJson(opts.pricingFile || PRICING_FILE, null);
    return (cached && cached.table) || {};
}

function usageFromEntry(e) {
    const u = e && e.message && e.message.usage;
    if (!u) return null;
    return {
        input: Number(u.input_tokens || 0),
        output: Number(u.output_tokens || 0),
        cacheRead: Number(u.cache_read_input_tokens || 0),
        cacheWrite: Number(u.cache_creation_input_tokens || 0),
        cacheWrite1h: u.cache_creation ? Number(u.cache_creation.ephemeral_1h_input_tokens || 0) : 0,
    };
}

function assistantActivity(e) {
    const content = e && e.message && e.message.content;
    if (!Array.isArray(content)) return 'Responding';
    let sawThinking = false;
    let sawText = false;
    for (const c of content) {
        if (!c || !c.type) continue;
        if (c.type === 'tool_use' && c.name) return 'Using ' + toolLabel(c.name);
        if (c.type === 'thinking') sawThinking = true;
        if (c.type === 'text') sawText = true;
    }
    if (sawThinking) return 'Thinking';
    if (sawText) return 'Responding';
    return 'Active';
}

function normalizeClaudeTranscript(transcript, entries, opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
    if (!transcript || !entries.length) {
        return {
            status: 'idle',
            source: 'claude-transcript-tail',
            ceiling: 'claude-hook-rich',
            missing: ['project', 'model', 'tokens', 'cost'],
            timestamps: { observedAt: new Date(now).toISOString() },
        };
    }

    let cwd = null;
    let model = null;
    let sessionId = null;
    let firstTs = null;
    let lastTs = null;
    let lastRelevant = null;
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let costAmount = 0;
    let priced = false;
    const seenUsage = new Set();
    const pricingTable = loadPricingTable(opts);

    for (const e of entries) {
        if (e.sessionId) sessionId = e.sessionId;
        if (e.cwd) cwd = e.cwd;
        if (e.timestamp) {
            const t = Date.parse(e.timestamp);
            if (Number.isFinite(t)) {
                if (firstTs === null) firstTs = t;
                lastTs = t;
            }
        }
        if (e.type === 'user' || e.type === 'assistant') lastRelevant = e;
        if (e.type !== 'assistant' || !e.message) continue;
        if (e.message.model) model = e.message.model;
        const usage = usageFromEntry(e);
        if (!usage) continue;
        const key = e.requestId || e.message.id || e.uuid || String(seenUsage.size);
        if (seenUsage.has(key)) continue;
        seenUsage.add(key);
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        const pricedCost = costFor(pricingTable, e.message.model, 'anthropic', usage);
        costAmount += pricedCost.cost;
        priced = priced || pricedCost.priced;
    }

    const lastMs = lastTs || transcript.mtimeMs || now;
    let activity = 'Active';
    if (lastRelevant) {
        activity = lastRelevant.type === 'user' ? 'Thinking' : assistantActivity(lastRelevant);
    }

    const missing = [];
    const project = cwd ? path.basename(String(cwd)) : null;
    if (!project) missing.push('project');
    if (!model) missing.push('model');
    if (!seenUsage.size) missing.push('tokens');
    if (!priced) missing.push('cost');

    return {
        status: now - lastMs <= freshnessMs ? 'active' : 'stale',
        source: 'claude-transcript-tail',
        ceiling: 'claude-hook-rich',
        agent: 'claude-code',
        project,
        model,
        activity,
        sessionId,
        tokens: seenUsage.size ? totals : null,
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

function readClaudePresenceState(opts = {}) {
    const fsObj = opts.fs || fs;
    const transcript = newestTranscript(opts.projectsDir || claudeProjectsDir(opts.home), fsObj);
    const entries = transcript ? parseJsonlFile(transcript.file, fsObj, opts.maxParseBytes || MAX_PARSE_BYTES) : [];
    return normalizeClaudeTranscript(transcript, entries, opts);
}

class ClaudeTranscriptPresenceSource extends EventEmitter {
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
        const state = readClaudePresenceState(this.opts);
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
    ClaudeTranscriptPresenceSource,
    claudeProjectsDir,
    newestTranscript,
    normalizeClaudeTranscript,
    parseJsonlFile,
    readClaudePresenceState,
    toolLabel,
};
