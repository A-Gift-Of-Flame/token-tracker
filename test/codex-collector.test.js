'use strict';

// BL-103: Codex collector format fidelity.
//
// We cannot run the Codex CLI on this host, so instead of a live rollout we
// verify the collector against a fixture written to the *exact* current
// upstream schema (openai/codex codex-rs/protocol/src/protocol.rs):
//   - line shape  { timestamp, type, payload }
//   - model from  turn_context.payload.model
//   - usage from  event_msg payload { type:"token_count", info.last_token_usage }
//   - TokenUsage.input_tokens INCLUDES cached_input_tokens
//     (matches Codex non_cached_input() = (input - cached).max(0))
//   - TokenUsage.output_tokens INCLUDES reasoning_output_tokens
//     (OpenAI Responses API: reasoning_tokens is a subset of output_tokens,
//      billed at the output rate) — so the collector takes output_tokens as-is.
//
// The collector resolves ~/.codex via os.homedir(), which honors $HOME on
// POSIX, so we point HOME at a temp tree and drop the committed fixture in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stageRollout() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '06', '13');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(__dirname, 'fixtures', 'codex-rollout.jsonl');
    fs.copyFileSync(src, path.join(dir, 'rollout-2026-06-13T10-00-00-CODEX.jsonl'));
    return home;
}

function withHome(home, fn) {
    const prev = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
    delete require.cache[require.resolve('../src/collectors/codex')];
    try { return fn(require('../src/collectors/codex')); }
    finally {
        if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
        if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
}

test('codex collector parses real-schema rollout', () => {
    const home = stageRollout();
    const recs = withHome(home, (codex) => codex.collect({}));

    assert.equal(recs.length, 2, 'two token_count events ingested');

    const [a, b] = recs;
    // event #1: input_tokens 1500 incl 1000 cached -> input 500, cacheRead 1000
    assert.equal(a.model, 'gpt-5-codex');
    assert.equal(a.provider, 'openai');
    assert.equal(a.agent, 'codex');
    assert.equal(a.input, 500);
    assert.equal(a.cacheRead, 1000);
    assert.equal(a.output, 300, 'output kept as-is (reasoning already inside it)');
    assert.equal(a.cacheWrite, 0);
    assert.equal(a.ts, '2026-06-13T10:00:05.000Z');

    // event #2: all 2000 input cached -> non-cached input clamps to 0
    assert.equal(b.input, 0, 'cached >= input clamps to 0');
    assert.equal(b.cacheRead, 2000);
    assert.equal(b.output, 50);

    // ids keyed by file basename + absolute line number (events on lines 4 & 6)
    assert.match(a.id, /^codex:rollout-2026-06-13T10-00-00-CODEX\.jsonl:4$/);
    assert.match(b.id, /^codex:rollout-2026-06-13T10-00-00-CODEX\.jsonl:6$/);
});

test('codex collector is idempotent via offset state', () => {
    const home = stageRollout();
    withHome(home, (codex) => {
        const state = {};
        const first = codex.collect(state);
        assert.equal(first.length, 2);
        const second = codex.collect(state);
        assert.equal(second.length, 0, 're-collect with carried state adds nothing');
    });
});
