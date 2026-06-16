'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const START_COMMAND = 'tt presence launch';
const END_COMMAND = 'tt presence session-end';

function claudeSettingsPath(opts = {}) {
    if (opts.settingsFile) return opts.settingsFile;
    const env = opts.env || process.env;
    if (env.CLAUDE_SETTINGS_FILE) return env.CLAUDE_SETTINGS_FILE;
    const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(dir, 'settings.json');
}

function readSettings(file, fsObj = fs) {
    try { return JSON.parse(fsObj.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeSettings(file, settings, fsObj = fs) {
    fsObj.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fsObj.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fsObj.renameSync(tmp, file);
}

function hookEntry(command) {
    return { hooks: [{ type: 'command', command }] };
}

function entryHasCommand(entry, command) {
    return !!(entry && Array.isArray(entry.hooks)
        && entry.hooks.some((h) => h && h.type === 'command' && h.command === command));
}

function ensureHook(settings, eventName, command) {
    settings.hooks = settings.hooks || {};
    const arr = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    if (!arr.some((entry) => entryHasCommand(entry, command))) arr.push(hookEntry(command));
    settings.hooks[eventName] = arr;
}

function removeHook(settings, eventName, command) {
    if (!settings.hooks || !Array.isArray(settings.hooks[eventName])) return;
    settings.hooks[eventName] = settings.hooks[eventName]
        .filter((entry) => !entryHasCommand(entry, command));
    if (!settings.hooks[eventName].length) delete settings.hooks[eventName];
}

function installPresenceHooks(opts = {}) {
    const fsObj = opts.fs || fs;
    const file = claudeSettingsPath(opts);
    const settings = readSettings(file, fsObj);
    ensureHook(settings, 'SessionStart', opts.startCommand || START_COMMAND);
    ensureHook(settings, 'SessionEnd', opts.endCommand || END_COMMAND);
    writeSettings(file, settings, fsObj);
    return { file, settings };
}

function uninstallPresenceHooks(opts = {}) {
    const fsObj = opts.fs || fs;
    const file = claudeSettingsPath(opts);
    const settings = readSettings(file, fsObj);
    removeHook(settings, 'SessionStart', opts.startCommand || START_COMMAND);
    removeHook(settings, 'SessionEnd', opts.endCommand || END_COMMAND);
    writeSettings(file, settings, fsObj);
    return { file, settings };
}

module.exports = {
    END_COMMAND,
    START_COMMAND,
    claudeSettingsPath,
    entryHasCommand,
    installPresenceHooks,
    uninstallPresenceHooks,
};
