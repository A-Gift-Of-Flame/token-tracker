'use strict';

// BL-112 per-project attribution: Claude Code transcript lines carry the
// session cwd; its basename rides onto the record as `project` and powers a
// `--by project` grouping. Agents without it degrade to "—".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-project-'));
process.env.TOKEN_TRACKER_DIR = tmp;
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const { parseLine } = require('../src/collectors/claude-code');
const { report } = require('../src/report');

function line(extra) {
    return JSON.stringify({
        type: 'assistant', requestId: 'req-' + Math.random().toString(36).slice(2),
        timestamp: '2026-06-10T00:00:00Z',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } },
        ...extra,
    });
}

test('parseLine attributes project from cwd basename', () => {
    const rec = parseLine(line({ cwd: '/home/me/projects/token-tracker' }));
    assert.equal(rec.project, 'token-tracker');
});

test('parseLine omits project when cwd absent', () => {
    const rec = parseLine(line({}));
    assert.equal('project' in rec, false);
});

test('--by project groups and degrades missing attribution to "—"', () => {
    fs.writeFileSync(path.join(dataDir, '2026-06.jsonl'), [
        { id: 'a', ts: '2026-06-10T00:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', project: 'token-tracker', input: 100, output: 0, cost: 1 },
        { id: 'b', ts: '2026-06-10T01:00:00Z', agent: 'claude-code', model: 'claude-opus-4-8', project: 'token-tracker', input: 50, output: 0, cost: 0.5 },
        { id: 'c', ts: '2026-06-10T02:00:00Z', agent: 'codex', model: 'gpt-5.5', input: 200, output: 0, cost: 2 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const r = report('all', 'project');
    const byKey = Object.fromEntries(r.rows.map((g) => [g.key, g]));
    assert.ok(Math.abs(byKey['token-tracker'].cost - 1.5) < 1e-12, 'two records summed');
    assert.equal(byKey['token-tracker'].requests, 2);
    assert.ok(byKey['—'], 'codex has no project → "—"');
    assert.equal(byKey['—'].cost, 2);
});
