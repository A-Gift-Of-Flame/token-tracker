'use strict';

// BL-102: Claude cache-write TTL tiers (5m = 1.25x input, 1h = 2x input).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { costFor } = require('../src/pricing');
const { parseLine } = require('../src/collectors/claude-code');

const IN = 3e-6; // per-token input rate used by the fixtures
const OUT = 15e-6;

// LiteLLM-style entry WITHOUT the 1h field (e.g. bare claude-sonnet-4-6)
const tableNo1h = {
    'claude-sonnet-4-6': {
        input_cost_per_token: IN,
        output_cost_per_token: OUT,
        cache_read_input_token_cost: IN * 0.1,
        cache_creation_input_token_cost: IN * 1.25,
    },
};

// Entry WITH the 1h field (e.g. anthropic.-prefixed keys)
const tableWith1h = {
    'claude-sonnet-4-6': {
        ...tableNo1h['claude-sonnet-4-6'],
        cache_creation_input_token_cost_above_1hr: 7e-6, // deliberately != IN * 2
    },
};

// Synthetic Claude Code transcript line: 5m = 1000, 1h = 400 cache-write tokens.
const LINE = JSON.stringify({
    type: 'assistant',
    requestId: 'req_test_bl102',
    timestamp: '2026-06-13T12:00:00.000Z',
    message: {
        model: 'claude-sonnet-4-6',
        usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 1400,
            cache_creation: {
                ephemeral_5m_input_tokens: 1000,
                ephemeral_1h_input_tokens: 400,
            },
        },
    },
});

test('collector records the 1h split from usage.cache_creation', () => {
    const rec = parseLine(LINE);
    assert.equal(rec.cacheWrite, 1400); // total, unchanged meaning
    assert.equal(rec.cacheWrite1h, 400);
});

test('collector omits cacheWrite1h when the split is absent', () => {
    const e = JSON.parse(LINE);
    delete e.message.usage.cache_creation;
    const rec = parseLine(JSON.stringify(e));
    assert.equal(rec.cacheWrite, 1400);
    assert.ok(!('cacheWrite1h' in rec));
});

// Expected costs mirror costFor's exact term order and rate values (left to
// right, table rates precomputed) so equality is bit-exact, not approximate.
function expectedCost(entry, rec, cw5m, cw1h, cw1hRate) {
    return rec.input * entry.input_cost_per_token
        + rec.output * entry.output_cost_per_token
        + rec.cacheRead * entry.cache_read_input_token_cost
        + cw5m * entry.cache_creation_input_token_cost
        + cw1h * cw1hRate;
}

test('split prices at 5m*1.25x + 1h*2x when table lacks the 1h field', () => {
    const rec = parseLine(LINE);
    const { cost, priced } = costFor(tableNo1h, rec.model, rec.provider, rec);
    assert.ok(priced);
    assert.equal(cost, expectedCost(tableNo1h['claude-sonnet-4-6'], rec, 1000, 400, IN * 2));
});

test('split uses the table 1h rate when present', () => {
    const rec = parseLine(LINE);
    const { cost } = costFor(tableWith1h, rec.model, rec.provider, rec);
    assert.equal(cost, expectedCost(tableWith1h['claude-sonnet-4-6'], rec, 1000, 400, 7e-6));
});

test('legacy record without cacheWrite1h prices as before BL-102', () => {
    const legacy = { input: 100, output: 50, cacheRead: 2000, cacheWrite: 1400 };
    const { cost } = costFor(tableNo1h, 'claude-sonnet-4-6', 'anthropic', legacy);
    // Pre-BL-102 formula: all cache writes at the 5m rate.
    assert.equal(cost, expectedCost(tableNo1h['claude-sonnet-4-6'], legacy, 1400, 0, IN * 2));
});

test('builtin fallback applies the same 1.25x / 2x tiers', () => {
    const rec = parseLine(LINE);
    const { cost, priced } = costFor({}, rec.model, rec.provider, rec);
    // BUILTIN claude-sonnet-4-6: in = 3e-6, out = 15e-6
    const expected = 100 * 3e-6 + 50 * 15e-6 + 2000 * 3e-6 * 0.1
        + 1000 * 3e-6 * 1.25 + 400 * 3e-6 * 2;
    assert.ok(priced);
    assert.equal(cost, expected);
});

test('cacheWrite1h is clamped to [0, cacheWrite]', () => {
    const over = { input: 0, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 500 };
    assert.equal(costFor(tableNo1h, 'claude-sonnet-4-6', 'anthropic', over).cost,
        100 * IN * 2); // all clamped to the 1h tier, never negative 5m tokens
    const negative = { input: 0, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite1h: -5 };
    assert.equal(costFor(tableNo1h, 'claude-sonnet-4-6', 'anthropic', negative).cost,
        100 * IN * 1.25);
});
