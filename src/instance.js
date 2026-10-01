'use strict';

// Single instance, newest wins, for long-running loops (watch, presence). Each
// instance writes its pid to <ROOT>/<name>.pid on start and stands down once
// another instance has claimed the file. This covers restarting a Windows
// scheduled task: ending the task kills conhost but leaves its node child
// running, so without this the old and new loops would both keep working.
// Writing pid 0 (service uninstall) tells every running instance to stop.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');

function instanceFile(name) {
    return path.join(ROOT, name + '.pid');
}

function claimInstance(name, pid = process.pid) {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(instanceFile(name), String(pid));
}

function ownsInstance(name, pid = process.pid) {
    try {
        return Number(fs.readFileSync(instanceFile(name), 'utf8').trim()) === pid;
    } catch {
        return true; // pidfile gone: nobody else claimed it, keep running
    }
}

module.exports = { claimInstance, instanceFile, ownsInstance };
