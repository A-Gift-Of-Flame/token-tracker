'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.TOKEN_TRACKER_DIR;

const {
    SERVICES,
    plistText,
    schtasksArgs,
    systemdUnitText,
} = require('../src/service');

test('systemd sync unit keeps the existing watcher shape', () => {
    const text = systemdUnitText(SERVICES.sync, 45);

    assert.equal(SERVICES.sync.label, 'token-tracker');
    assert.match(text, /Description=token-tracker continuous sync\+push/);
    assert.match(text, /ExecStart=.*tt\.js watch --interval 45/);
    assert.match(text, /Restart=always/);
    assert.match(text, /\[Install\]\nWantedBy=default\.target/);
});

test('systemd presence unit runs multiplexed presence without watch interval', () => {
    const text = systemdUnitText(SERVICES.presence, 45);

    assert.equal(SERVICES.presence.label, 'token-tracker-presence');
    assert.match(text, /ExecStart=.*tt\.js presence --all/);
    assert.doesNotMatch(text, /--interval/);
    assert.match(text, /Restart=always/);
});

test('launchd plist uses the service label and arguments', () => {
    const sync = plistText(SERVICES.sync, 30);
    const presence = plistText(SERVICES.presence, 30);

    assert.match(sync, /<key>Label<\/key><string>com\.token-tracker\.watch<\/string>/);
    assert.match(sync, /<string>watch<\/string>\n    <string>--interval<\/string>\n    <string>30<\/string>/);
    assert.match(presence, /<key>Label<\/key><string>token-tracker-presence<\/string>/);
    assert.match(presence, /<string>presence<\/string>\n    <string>--all<\/string>/);
    assert.doesNotMatch(presence, /--interval/);
});

test('schtasks args use the service task name and command args', () => {
    const sync = schtasksArgs(SERVICES.sync, 15);
    const presence = schtasksArgs(SERVICES.presence, 15);

    assert.equal(sync[sync.indexOf('/tn') + 1], 'token-tracker-watch');
    assert.match(sync[sync.indexOf('/tr') + 1], /tt\.js" watch --interval 15/);
    assert.equal(presence[presence.indexOf('/tn') + 1], 'token-tracker-presence');
    assert.match(presence[presence.indexOf('/tr') + 1], /tt\.js" presence --all/);
    assert.doesNotMatch(presence[presence.indexOf('/tr') + 1], /--interval/);
});
