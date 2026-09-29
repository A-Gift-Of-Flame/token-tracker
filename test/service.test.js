'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.TOKEN_TRACKER_DIR;

const {
    SERVICES,
    plistText,
    schtasksArgs,
    schtasksXml,
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

test('schtasks args create the named task from an XML definition', () => {
    const sync = schtasksArgs(SERVICES.sync, 'C:\\t\\sync.xml');
    const presence = schtasksArgs(SERVICES.presence, 'C:\\t\\p.xml');

    assert.equal(sync[sync.indexOf('/tn') + 1], 'token-tracker-watch');
    assert.equal(sync[sync.indexOf('/xml') + 1], 'C:\\t\\sync.xml');
    assert.equal(presence[presence.indexOf('/tn') + 1], 'token-tracker-presence');
    assert.ok(!sync.includes('/sc'), 'no any-user /sc onlogon trigger (needs admin)');
});

test('schtasks XML: user-scoped logon trigger, no time limit, runs on battery, headless', () => {
    const sync = schtasksXml(SERVICES.sync, 15, 'GASTLY\\mauro');
    const presence = schtasksXml(SERVICES.presence, 15, 'GASTLY\\mauro');

    assert.match(sync, /<LogonTrigger><Enabled>true<\/Enabled><UserId>GASTLY\\mauro<\/UserId>/);
    assert.match(sync, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(sync, /<DisallowStartIfOnBatteries>false</);
    assert.match(sync, /<StopIfGoingOnBatteries>false</);
    assert.match(sync, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(sync, /<Command>conhost\.exe<\/Command><Arguments>--headless &quot;.*tt\.js&quot; watch --interval 15</);
    assert.match(presence, /tt\.js&quot; presence --all</);
    assert.doesNotMatch(presence, /--interval/);
});
