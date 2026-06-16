'use strict';

const EventEmitter = require('events');
const { DEFAULT_FRESHNESS_MS } = require('./source');

function parseLastActivity(state) {
    const value = state && state.timestamps && state.timestamps.lastActivityAt;
    const ms = value ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

class PresenceMultiplexer extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.sources = Array.isArray(opts.sources) ? opts.sources : [];
        this.freshnessMs = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
        this.now = opts.now || (() => Date.now());
        this.latest = new Map();
        this.handlers = new Map();
        this.started = false;
    }

    start() {
        if (this.started) return;
        this.started = true;
        for (const entry of this.sources) {
            if (!entry || !entry.source || typeof entry.source.on !== 'function') continue;
            const handler = (state) => {
                try {
                    this.latest.set(entry.name, state);
                    this.emit('state', this.combinedState());
                } catch {
                    /* Never let a child source event handler throw. */
                }
            };
            this.handlers.set(entry.name, handler);
            entry.source.on('state', handler);
        }
        for (const entry of this.sources) {
            if (entry && entry.source && typeof entry.source.start === 'function') entry.source.start();
        }
    }

    stop() {
        for (const entry of this.sources) {
            const handler = entry && this.handlers.get(entry.name);
            if (handler && entry.source && typeof entry.source.removeListener === 'function') {
                entry.source.removeListener('state', handler);
            }
        }
        this.handlers.clear();
        for (const entry of this.sources) {
            if (entry && entry.source && typeof entry.source.stop === 'function') entry.source.stop();
        }
        this.started = false;
    }

    combinedState() {
        const now = this.now();
        const live = [];
        for (const entry of this.sources) {
            if (!entry || !entry.name) continue;
            const state = this.latest.get(entry.name);
            const last = parseLastActivity(state);
            const status = state && state.status;
            if ((status !== 'fresh' && status !== 'active') || last === null) continue;
            if (now - last > this.freshnessMs) continue;
            live.push({
                name: entry.name,
                tier: Number(entry.tier || 0),
                last,
                state,
            });
        }
        if (!live.length) return { status: 'idle' };

        live.sort((a, b) => {
            if (b.tier !== a.tier) return b.tier - a.tier;
            return b.last - a.last;
        });
        const headline = live[0];
        return {
            status: 'active',
            headline: headline.state,
            background: live.slice(1).map((entry) => entry.state),
        };
    }
}

module.exports = {
    PresenceMultiplexer,
    parseLastActivity,
};
