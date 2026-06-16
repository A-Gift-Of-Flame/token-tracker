'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function encodeFrame(op, payload) {
    const body = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
}

function decodeFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (buffer.length - offset >= 8) {
        const op = buffer.readInt32LE(offset);
        const len = buffer.readInt32LE(offset + 4);
        if (len < 0) throw new Error('invalid Discord IPC frame length');
        if (buffer.length - offset < 8 + len) break;
        const raw = buffer.slice(offset + 8, offset + 8 + len).toString('utf8');
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
        frames.push({ op, payload });
        offset += 8 + len;
    }
    return { frames, rest: buffer.slice(offset) };
}

function ipcCandidatePaths(env = process.env, platform = process.platform) {
    if (platform === 'win32') {
        const out = [];
        for (let i = 0; i < 10; i++) out.push('\\\\?\\pipe\\discord-ipc-' + i);
        return out;
    }
    const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean);
    const prefixes = ['', 'snap.discord/', 'app/com.discordapp.Discord/'];
    const out = [];
    for (const base of bases) {
        for (const prefix of prefixes) {
            for (let i = 0; i < 10; i++) out.push(path.join(base, prefix + 'discord-ipc-' + i));
        }
    }
    return [...new Set(out)];
}

class DiscordIPC {
    constructor(clientId, opts = {}) {
        this.clientId = clientId;
        this.paths = opts.paths || null;
        this.createConnection = opts.createConnection || net.createConnection;
        this.existsSync = opts.existsSync || fs.existsSync;
        this.pid = opts.pid || process.pid;
        this.readyTimeoutMs = opts.readyTimeoutMs || 10000;
        this.socket = null;
        this.ready = false;
        this._buf = Buffer.alloc(0);
        this._readyResolve = null;
        this._readyReject = null;
        this._readyTimer = null;
        this.onClose = null;
    }

    connect() {
        if (!this.clientId) return Promise.reject(new Error('Discord client id is not configured'));
        const paths = this.paths || ipcCandidatePaths();
        return new Promise((resolve, reject) => {
            const tryNext = (i) => {
                if (i >= paths.length) {
                    reject(new Error('Discord IPC socket not found. Is Discord running?'));
                    return;
                }
                const candidate = paths[i];
                if (process.platform !== 'win32' && !this.existsSync(candidate)) {
                    tryNext(i + 1);
                    return;
                }
                const socket = this.createConnection(candidate);
                let settled = false;
                const fail = () => {
                    if (settled) return;
                    settled = true;
                    try { socket.destroy(); } catch { /* ignore */ }
                    tryNext(i + 1);
                };
                socket.once('error', fail);
                socket.once('connect', () => {
                    settled = true;
                    socket.removeListener('error', fail);
                    this.socket = socket;
                    this._readyResolve = resolve;
                    this._readyReject = reject;
                    this._readyTimer = setTimeout(() => {
                        this._rejectReady(new Error('Discord IPC connected but did not become ready'));
                        this.destroy();
                    }, this.readyTimeoutMs);
                    socket.on('error', () => this._down());
                    socket.on('close', () => this._down());
                    socket.on('data', (chunk) => this._onData(chunk));
                    this._send(OP.HANDSHAKE, { v: 1, client_id: this.clientId }).catch((err) => {
                        this._rejectReady(err);
                    });
                });
            };
            tryNext(0);
        });
    }

    _resolveReady() {
        if (this._readyTimer) clearTimeout(this._readyTimer);
        this._readyTimer = null;
        const resolve = this._readyResolve;
        this._readyResolve = null;
        this._readyReject = null;
        if (resolve) resolve(this);
    }

    _rejectReady(err) {
        if (this._readyTimer) clearTimeout(this._readyTimer);
        this._readyTimer = null;
        const reject = this._readyReject;
        this._readyResolve = null;
        this._readyReject = null;
        if (reject) reject(err);
    }

    _down() {
        const hadSocket = !!this.socket;
        this.ready = false;
        this.socket = null;
        this._rejectReady(new Error('Discord IPC socket closed before READY'));
        if (hadSocket && this.onClose) this.onClose();
    }

    _send(op, payload) {
        if (!this.socket) return Promise.resolve(false);
        const frame = encodeFrame(op, payload);
        return new Promise((resolve, reject) => {
            this.socket.write(frame, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    _onData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);
        let decoded;
        try {
            decoded = decodeFrames(this._buf);
        } catch {
            this.destroy();
            return;
        }
        this._buf = decoded.rest;
        for (const frame of decoded.frames) {
            if (frame.op === OP.PING) {
                this._send(OP.PONG, frame.payload).catch(() => {});
                continue;
            }
            if (frame.op === OP.CLOSE) {
                if (this.socket) this.socket.end();
                continue;
            }
            if (frame.payload && frame.payload.evt === 'READY') {
                this.ready = true;
                this._resolveReady();
            }
        }
    }

    setActivity(activity) {
        if (!this.ready) return Promise.resolve(false);
        return this._send(OP.FRAME, {
            cmd: 'SET_ACTIVITY',
            args: { pid: this.pid, activity },
            nonce: randomUUID(),
        });
    }

    clear() {
        return this.setActivity(null);
    }

    destroy() {
        if (this._readyTimer) clearTimeout(this._readyTimer);
        this._readyTimer = null;
        const socket = this.socket;
        this.ready = false;
        this.socket = null;
        if (socket) {
            try { socket.destroy(); } catch { /* ignore */ }
        }
    }
}

module.exports = { DiscordIPC, OP, encodeFrame, decodeFrames, ipcCandidatePaths };
