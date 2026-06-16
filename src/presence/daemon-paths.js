'use strict';

const path = require('path');
const { ROOT } = require('../paths');

function daemonPaths(opts = {}) {
    const stateDir = opts.stateDir || path.join(opts.root || ROOT, 'presence-daemon');
    return {
        STATE_DIR: stateDir,
        LOCK: path.join(stateDir, 'daemon.lock'),
        LIVE_FILE: path.join(stateDir, 'live.json'),
        ENDED_FILE: path.join(stateDir, 'ended.json'),
        STATUS_FILE: path.join(stateDir, 'status.json'),
        LOG: path.join(stateDir, 'daemon.log'),
    };
}

module.exports = { daemonPaths };
