'use strict';

// Copilot CLI collector — reads ~/.copilot/session-state/*/events.jsonl.
// Each session's events.jsonl ends with a "session.shutdown" event that
// carries full per-model token counts in data.modelMetrics:
//   { "<model>": { usage: { inputTokens, outputTokens, cacheReadTokens,
//                            cacheWriteTokens, reasoningTokens } } }
// reasoningTokens is a subset of outputTokens (Claude extended thinking),
// already included in outputTokens — no separate billing needed.
// cwd comes from the "session.start" event's data.context.cwd.
//
// One record is emitted per model per session. Sessions without a shutdown
// event (still active or empty) are skipped and retried on the next sync.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'copilot-cli';

function providerFor(model) {
    if (/^claude/.test(model)) return 'anthropic';
    if (/^(gpt-|o[1-9]-|o[1-9]$|text-|dall-e)/.test(model)) return 'openai';
    if (/^gemini/.test(model)) return 'google';
    return 'unknown';
}

function sessionDirs(copilotRoot) {
    const stateDir = path.join(copilotRoot || path.join(os.homedir(), '.copilot'), 'session-state');
    let entries;
    try { entries = fs.readdirSync(stateDir); } catch { return []; }
    return entries.map(e => ({ id: e, dir: path.join(stateDir, e) }));
}

function parseSession(eventsFile) {
    let text;
    try { text = fs.readFileSync(eventsFile, 'utf8'); } catch { return null; }

    let cwd = null;
    let shutdown = null;

    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }

        if (e.type === 'session.start' && e.data && e.data.context) {
            cwd = e.data.context.cwd || null;
        }
        if (e.type === 'session.shutdown' && e.data && e.data.modelMetrics) {
            shutdown = { data: e.data, timestamp: e.timestamp };
        }
    }

    if (!shutdown) return null; // session still active or empty

    return { cwd, shutdown };
}

function collect(state, copilotRoot) {
    const processed = new Set(state.processedSessions || []);
    const records = [];

    for (const { id: sessionId, dir } of sessionDirs(copilotRoot)) {
        if (processed.has(sessionId)) continue;

        const eventsFile = path.join(dir, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) continue;

        const parsed = parseSession(eventsFile);
        if (!parsed) continue; // still active

        const { cwd, shutdown } = parsed;
        const { modelMetrics, sessionStartTime } = shutdown.data;
        const ts = sessionStartTime
            ? new Date(sessionStartTime).toISOString()
            : shutdown.timestamp;
        const project = cwd ? path.basename(cwd) : null;

        for (const [model, metrics] of Object.entries(modelMetrics)) {
            const u = metrics.usage || {};
            if (!(u.inputTokens || u.outputTokens || u.cacheReadTokens || u.cacheWriteTokens)) continue;
            records.push({
                id: NAME + ':' + sessionId + ':' + model,
                ts,
                agent: NAME,
                model,
                provider: providerFor(model),
                input: u.inputTokens || 0,
                output: u.outputTokens || 0,
                cacheRead: u.cacheReadTokens || 0,
                cacheWrite: u.cacheWriteTokens || 0,
                ...(project ? { project } : {}),
            });
        }

        processed.add(sessionId);
    }

    state.processedSessions = [...processed];
    return records;
}

module.exports = { name: NAME, collect, providerFor, sessionDirs, parseSession };
