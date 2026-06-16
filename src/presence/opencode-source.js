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
const DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function opencodeDbPath(home = os.homedir()) {
    return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
}

function sqliteLocation(dbPath) {
    return 'file:' + path.resolve(dbPath) + '?mode=ro&immutable=1';
}

function loadPricingTable(opts = {}) {
    if (opts.pricingTable) return opts.pricingTable;
    const cached = readJson(opts.pricingFile || PRICING_FILE, null);
    return (cached && cached.table) || {};
}

function parseJson(s) {
    if (!s || typeof s !== 'string') return null;
    try { return JSON.parse(s); } catch { return null; }
}

function tableColumns(db, table) {
    try {
        return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name));
    } catch {
        return new Set();
    }
}

function tableExists(db, table) {
    try {
        return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    } catch {
        return false;
    }
}

function newestSessionId(db) {
    if (tableExists(db, 'session')) {
        const cols = tableColumns(db, 'session');
        const order = cols.has('time_updated') ? 'time_updated' : (cols.has('time_created') ? 'time_created' : 'id');
        const row = db.prepare('SELECT * FROM session ORDER BY ' + order + ' DESC LIMIT 1').get();
        if (row && row.id) return row.id;
    }
    if (tableExists(db, 'message')) {
        const cols = tableColumns(db, 'message');
        if (cols.has('session_id')) {
            const row = db.prepare('SELECT session_id FROM message ORDER BY time_created DESC LIMIT 1').get();
            if (row && row.session_id) return row.session_id;
        }
    }
    if (tableExists(db, 'part')) {
        const cols = tableColumns(db, 'part');
        if (cols.has('session_id')) {
            const row = db.prepare('SELECT session_id FROM part ORDER BY time_created DESC LIMIT 1').get();
            if (row && row.session_id) return row.session_id;
        }
    }
    return null;
}

function sessionRow(db, sessionId) {
    if (!sessionId || !tableExists(db, 'session')) return null;
    try { return db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) || null; } catch { return null; }
}

function rowsForSession(db, table, sessionId) {
    if (!sessionId || !tableExists(db, table)) return [];
    const cols = tableColumns(db, table);
    try {
        if (table === 'event') {
            if (!cols.has('aggregate_id')) return [];
            return db.prepare('SELECT * FROM event WHERE aggregate_id = ? ORDER BY seq').all(sessionId);
        }
        if (!cols.has('session_id')) return [];
        const order = cols.has('time_created') ? 'time_created' : (cols.has('time_updated') ? 'time_updated' : 'id');
        return db.prepare('SELECT * FROM ' + table + ' WHERE session_id = ? ORDER BY ' + order).all(sessionId);
    } catch {
        return [];
    }
}

function msFromRow(row, data) {
    const candidates = [
        data && data.time && data.time.completed,
        data && data.time && data.time.updated,
        data && data.time && data.time.created,
        row && row.time_updated,
        row && row.time_created,
    ];
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function modelFromValue(value) {
    if (!value) return { model: null, provider: null };
    if (typeof value === 'string') {
        const parsed = parseJson(value);
        if (parsed) return modelFromValue(parsed);
        return { model: value, provider: null };
    }
    if (typeof value === 'object') {
        return {
            model: value.modelID || value.id || value.model || null,
            provider: value.providerID || value.provider || null,
        };
    }
    return { model: null, provider: null };
}

function usageFromTokens(tokens) {
    if (!tokens) return null;
    const cache = tokens.cache || {};
    const usage = {
        input: Number(tokens.input || 0),
        output: Number(tokens.output || 0) + Number(tokens.reasoning || 0),
        cacheRead: Number(cache.read || tokens.cacheRead || tokens.tokens_cache_read || 0),
        cacheWrite: Number(cache.write || tokens.cacheWrite || tokens.tokens_cache_write || 0),
    };
    return ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => usage[k]) ? usage : null;
}

function usageFromSession(row) {
    if (!row) return null;
    const usage = {
        input: Number(row.tokens_input || 0),
        output: Number(row.tokens_output || 0) + Number(row.tokens_reasoning || 0),
        cacheRead: Number(row.tokens_cache_read || 0),
        cacheWrite: Number(row.tokens_cache_write || 0),
    };
    return ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => usage[k]) ? usage : null;
}

function projectFromPath(value) {
    if (!value) return null;
    if (typeof value === 'object') {
        return projectFromPath(value.cwd || value.path || value.directory || value.root);
    }
    const s = String(value);
    if (!s) return null;
    return path.basename(s.replace(/\/+$/, '')) || null;
}

function activityFromPart(row) {
    const d = parseJson(row && row.data) || {};
    if (d.type === 'tool' && d.tool) return 'Using ' + toolLabel(d.tool);
    if (d.type === 'reasoning') return 'Reasoning';
    if (d.type === 'step-start') return 'Step started';
    if (d.type === 'step-finish') return 'Step finished';
    return null;
}

function activityFromEvent(row) {
    const d = parseJson(row && row.data) || {};
    const type = d.type || row.type || '';
    if (type === 'tool' && d.tool) return 'Using ' + toolLabel(d.tool);
    if (type === 'reasoning') return 'Reasoning';
    if (type === 'step-start') return 'Step started';
    if (type === 'step-finish') return 'Step finished';
    return null;
}

function localExactCost(provider, sourceCost) {
    const p = String(provider || '').toLowerCase();
    if (!['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'local', 'vllm'].includes(p)) return null;
    const n = Number(sourceCost);
    return Number.isFinite(n) && n === 0 ? n : 0;
}

function normalizeOpenCodeRows(snapshot, opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
    const session = snapshot && snapshot.session;
    const messages = (snapshot && snapshot.messages) || [];
    const parts = (snapshot && snapshot.parts) || [];
    const events = (snapshot && snapshot.events) || [];
    if (!snapshot || !session) {
        return {
            status: 'idle',
            source: 'opencode-db-tail',
            ceiling: 'opencode-live-tail',
            agent: 'opencode',
            project: null,
            model: null,
            activity: null,
            tokens: null,
            cost: null,
            timestamps: { startedAt: null, lastActivityAt: null, observedAt: new Date(now).toISOString() },
            missing: ['project', 'model', 'activity', 'tokens', 'cost'],
        };
    }

    let project = projectFromPath(session.directory || session.path);
    let modelInfo = modelFromValue(session.model);
    let model = modelInfo.model;
    let provider = modelInfo.provider;
    let firstMs = Number(session.time_created || 0) || null;
    let lastMs = Number(session.time_updated || session.time_created || 0) || null;
    let activity = null;
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let tokenRows = 0;
    const pricingTable = loadPricingTable(opts);

    for (const row of messages) {
        const d = parseJson(row.data) || {};
        const ms = msFromRow(row, d);
        if (ms !== null) {
            if (firstMs === null || ms < firstMs) firstMs = ms;
            if (lastMs === null || ms > lastMs) lastMs = ms;
        }
        if (!project) project = projectFromPath(d.path || (d.path && d.path.cwd));
        const mi = modelFromValue(d.model || { modelID: d.modelID, providerID: d.providerID });
        if (mi.model) model = mi.model;
        if (mi.provider) provider = mi.provider;
        if (d.role !== 'assistant') continue;
        const usage = usageFromTokens(d.tokens);
        if (!usage) continue;
        tokenRows++;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
    }

    for (const row of parts) {
        const d = parseJson(row.data) || {};
        const ms = msFromRow(row, d);
        if (ms !== null) {
            if (firstMs === null || ms < firstMs) firstMs = ms;
            if (lastMs === null || ms > lastMs) lastMs = ms;
        }
        const a = activityFromPart(row);
        if (a) activity = a;
        if (tokenRows) continue;
        const usage = d.type === 'step-finish' ? usageFromTokens(d.tokens) : null;
        if (!usage) continue;
        tokenRows++;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        if (Number.isFinite(Number(d.cost))) session.cost = Number(d.cost);
    }

    for (const row of events) {
        const d = parseJson(row.data) || {};
        const info = d.info || {};
        const ms = msFromRow(row, info) || msFromRow(row, d);
        if (ms !== null) {
            if (firstMs === null || ms < firstMs) firstMs = ms;
            if (lastMs === null || ms > lastMs) lastMs = ms;
        }
        if (!project) project = projectFromPath(info.directory || info.path);
        const mi = modelFromValue(info.model);
        if (!model && mi.model) model = mi.model;
        if (!provider && mi.provider) provider = mi.provider;
        const a = activityFromEvent(row);
        if (a) activity = a;
    }

    if (!tokenRows) {
        const usage = usageFromSession(session);
        if (usage) {
            tokenRows = 1;
            totals.input += usage.input;
            totals.output += usage.output;
            totals.cacheRead += usage.cacheRead;
            totals.cacheWrite += usage.cacheWrite;
        }
    }

    let cost = null;
    const exactLocal = localExactCost(provider, session.cost);
    if (exactLocal !== null) {
        cost = {
            amount: exactLocal,
            currency: 'USD',
            estimated: false,
            estimateFlag: false,
            exact: true,
            exactFlag: true,
        };
    } else if (tokenRows) {
        const pricedCost = costFor(pricingTable, model, provider || 'opencode', totals);
        if (pricedCost.priced) {
            cost = {
                amount: pricedCost.cost,
                currency: 'USD',
                estimated: true,
                estimateFlag: true,
                exact: false,
                exactFlag: false,
            };
        }
    }

    const missing = [];
    if (!project) missing.push('project');
    if (!model) missing.push('model');
    if (!activity) missing.push('activity');
    if (!tokenRows) missing.push('tokens');
    if (!cost) missing.push('cost');
    const effectiveLastMs = lastMs || now;

    return {
        status: now - effectiveLastMs <= freshnessMs ? 'active' : 'stale',
        source: 'opencode-db-tail',
        ceiling: 'opencode-live-tail',
        agent: 'opencode',
        project,
        model,
        activity,
        tokens: tokenRows ? totals : null,
        cost,
        timestamps: {
            startedAt: firstMs === null ? null : new Date(firstMs).toISOString(),
            lastActivityAt: new Date(effectiveLastMs).toISOString(),
            observedAt: new Date(now).toISOString(),
        },
        missing,
    };
}

function readOpenCodePresenceState(opts = {}) {
    const dbPath = opts.dbPath || opencodeDbPath(opts.home);
    const fsObj = opts.fs || fs;
    if (!fsObj.existsSync(dbPath)) return normalizeOpenCodeRows(null, opts);
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return normalizeOpenCodeRows(null, opts); }
    let db;
    try {
        db = new DatabaseSync(sqliteLocation(dbPath), { readOnly: true });
        const sessionId = opts.sessionId || newestSessionId(db);
        const snapshot = sessionId ? {
            session: sessionRow(db, sessionId),
            messages: rowsForSession(db, 'message', sessionId),
            parts: rowsForSession(db, 'part', sessionId),
            events: rowsForSession(db, 'event', sessionId),
        } : null;
        return normalizeOpenCodeRows(snapshot, opts);
    } catch {
        return normalizeOpenCodeRows(null, opts);
    } finally {
        try { if (db) db.close(); } catch { /* ignore */ }
    }
}

class OpenCodeDbPresenceSource extends EventEmitter {
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
        const state = readOpenCodePresenceState(this.opts);
        this.latestState = state;
        const sig = JSON.stringify(state);
        if (sig === this.lastSignature) return;
        this.lastSignature = sig;
        this.emit('state', state);
    }
}

module.exports = {
    DEFAULT_POLL_MS,
    DB,
    OpenCodeDbPresenceSource,
    activityFromPart,
    normalizeOpenCodeRows,
    opencodeDbPath,
    readOpenCodePresenceState,
    sqliteLocation,
    usageFromTokens,
};
