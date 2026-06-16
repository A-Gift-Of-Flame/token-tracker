#!/usr/bin/env node
'use strict';

const { sync, COLLECTORS } = require('../src/collectors');
const { report, render } = require('../src/report');
const { getPricing, SOURCE_URL } = require('../src/pricing');
const store = require('../src/store');
const { ROOT } = require('../src/paths');

const HELP = `token-tracker — AI agent token usage, with live pricing

Usage: tt <command> [options]

Reports (sync runs automatically first):
  tt today                     usage today
  tt week                      usage this week (Mon-Sun)
  tt month                     usage this month
  tt year                      usage this year
  tt all                       all recorded usage
  tt last --last N             rolling window: the last N days
    --by agent|model|agent-model|project|day|month   grouping (default: agent-model)
                               (project: Claude Code only; others show "—")
    --last N                   rolling N-day window (overrides the period word)
    --trend                    append a per-day cost sparkline
    --forecast                 project period-end cost from run-rate (week/month/year)
    --efficiency               $/M output, cache hit rate, cache savings vs no-cache
    --vs last                  delta vs the prior period (cost/requests/tokens, abs + %)
    --compact                  cost-only table (drops token columns)
    --json                     raw JSON output
    --no-sync                  report from stored data only
    --offline                  skip pricing refresh

Subscription subsidy (how much a flat plan beats metered API):
  tt subsidy [period]          API-equiv spend vs prorated fee + crossover/break-even
                               (default period: month; honors --last/--offline)
    --set prov.plan=USD[,...]  set monthly fee(s), e.g. claude.pro=20,chatgpt.pro=200
    --json                     raw JSON output

Local dashboard:
  tt serve [--port N] [--interval S]
                               dev server: HTML dashboard + JSON API
                               (auto-syncs every S seconds, default 60; 0 disables)
                               (default port 7777; GET /api/<period>?by=<grouping>)

Discord presence (opt-in):
  tt presence [--interval S] [--fresh S] [--source NAME] [--all]
                               connect Discord IPC, publish truthful local usage
                               presence, clear on Ctrl-C (default interval 5s;
                               records older than --fresh seconds show stale)
                               sources: store (default), claude, codex,
                               gemini, opencode; --all multiplexes live agents
  tt presence install          opt in: add Claude Code SessionStart/SessionEnd
                               hooks for the bounded presence daemon
  tt presence uninstall        remove token-tracker Claude Code presence hooks

Data:
  tt sync [--push|--no-push]   collect new usage from all agents; optionally push
                               (auto-push uses remote.json opt-in)
  tt watch [--interval S]      always-on: sync+push every S seconds (default 60),
                               no dashboard (foreground; Ctrl-C to stop).
  tt service install           install + start the always-on watcher as a boot
         [--interval S]        service (systemd / launchd / Scheduled Task —
         [--presence]          auto-detected). Survives reboots and crashes.
                               --presence also installs opt-in
                               always-on Discord presence (tt presence --all).
  tt service uninstall         stop and remove sync + presence boot services.
         [--presence]          remove only the opt-in presence service.
  tt service status            show sync + presence service status.
  tt log --agent X --model Y --input N --output M
         [--cache-read N] [--cache-write N] [--ts ISO]   record manually
  tt agents                    list collectors and the inbox path
  tt pricing [--refresh]       pricing cache status
  tt reprice [--dry-run]       recompute stored costs from the current price
             [--force]         table (--dry-run previews; --force overrides the
                               live-pricing guard)
  tt reproject [--dry-run]     backfill project on old Claude Code records from
                               the on-disk transcripts (for --by project)
  tt export [period]           CSV (default) or --md; aggregated report or
            [--md] [--records] --records (raw rows); --by GROUP, --out FILE
            [--by G] [--out F]  (default stdout; honors --last/--no-sync)
            [--ledger]          --ledger: lossless raw JSONL for tt import
  tt import FILE [FILE...]     merge a --ledger export from another machine;
            [--dry-run]        dedup by record id (re-import never double-counts)
  tt budget [--set USD]        monthly budget/ceiling (tt month shows % consumed;
            [--clear]          --forecast projects month-end)
            [--set-daily USD]  daily cost ceiling
            [--clear-daily]    ceilings warn on tt sync + reports when crossed

Remote push (cloud tier — opt-in):
  tt login <token> --endpoint URL [--auto-push]
                                  save device token + server URL to remote.json (0600)
  tt login --github --endpoint URL [--auto-push]
                                  sign in with GitHub device flow, then save
                                  the minted server device token
  tt push [--since ISO]            push new local records to the remote (idempotent)
  tt remote status                 show remote config + last-push timestamp
  tt remote auto-push on|off       push automatically after tt sync

Sources: Claude Code, Codex CLI, OpenCode (automatic). Anything else via
"tt log" or JSONL files dropped in ${ROOT}/inbox/.
`;

function parseArgs(argv) {
    const args = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                args.flags[key] = next;
                i++;
            } else {
                args.flags[key] = true;
            }
        } else {
            args._.push(a);
        }
    }
    return args;
}

function printPushResult(r) {
    if (r.pushed === 0) {
        console.log('nothing new to push (already up to date)');
    } else {
        console.log('pushed ' + r.pushed + ' record(s) to ' + r.endpoint);
        console.log('added ' + r.added + ', duplicate ' + r.duplicate
            + (r.invalid ? ', invalid ' + r.invalid : ''));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0] || 'today';
    const offline = !!args.flags.offline;

    switch (cmd) {
        case 'help':
        case '--help':
            console.log(HELP);
            return;

        case 'serve': {
            const { serve } = require('../src/server');
            await serve({
                port: Number(args.flags.port || 7777),
                offline,
                interval: args.flags.interval === undefined ? 60 : Number(args.flags.interval),
            });
            return; // server keeps the process alive until Ctrl-C
        }

        case 'watch': {
            const { watch } = require('../src/watch');
            await watch({
                offline,
                interval: args.flags.interval === undefined ? 60 : Number(args.flags.interval),
            });
            return; // the interval keeps the process alive until Ctrl-C
        }

        case 'service': {
            const service = require('../src/service');
            const sub = args._[1] || 'install';
            let r;
            if (sub === 'install') {
                r = service.install({ interval: args.flags.interval, presence: !!args.flags.presence });
            } else if (sub === 'uninstall' || sub === 'remove') {
                r = service.uninstall({ presenceOnly: !!args.flags.presence });
            } else if (sub === 'status') {
                r = service.status();
            } else {
                console.error('unknown service subcommand: ' + sub + ' (try: install|uninstall|status)');
                process.exit(1);
            }
            console.log(r.message);
            if (!r.ok) process.exit(1);
            return;
        }

        case 'presence': {
            if (args.flags.help) { console.log(HELP); return; }
            const sub = args._[1];
            if (sub === 'launch') {
                const { runLauncher } = require('../src/presence/launcher');
                await runLauncher();
                return;
            }
            if (sub === 'daemon') {
                const { runDaemon } = require('../src/presence/daemon');
                await runDaemon();
                return;
            }
            if (sub === 'session-end') {
                const { runSessionEnd } = require('../src/presence/session-end');
                await runSessionEnd();
                return;
            }
            if (sub === 'install') {
                const { installPresenceHooks } = require('../src/presence/install');
                const r = installPresenceHooks();
                console.log('installed Claude Code presence hooks in ' + r.file);
                console.log('daemon path is opt-in and bounded: it clears/exits when the watched Claude session ends.');
                console.log('while installed and active, daemon presence owns the Discord slot; foreground tt presence should not run at the same time.');
                return;
            }
            if (sub === 'uninstall') {
                const { uninstallPresenceHooks } = require('../src/presence/install');
                const r = uninstallPresenceHooks();
                console.log('removed token-tracker Claude Code presence hooks from ' + r.file);
                return;
            }
            if (sub && sub.startsWith('-') === false) {
                console.error('unknown presence subcommand: ' + sub + ' (try: install|uninstall)');
                process.exit(1);
            }
            const { runPresence } = require('../src/presence/engine');
            const interval = args.flags.interval === undefined ? undefined : Number(args.flags.interval);
            const fresh = args.flags.fresh === undefined ? undefined : Number(args.flags.fresh);
            const sourceName = args.flags.all ? 'all'
                : (args.flags.source === undefined ? undefined : String(args.flags.source));
            if (interval !== undefined && (!Number.isFinite(interval) || interval <= 0)) {
                console.error('--interval needs a positive number of seconds');
                process.exit(1);
            }
            if (fresh !== undefined && (!Number.isFinite(fresh) || fresh <= 0)) {
                console.error('--fresh needs a positive number of seconds');
                process.exit(1);
            }
            if (sourceName !== undefined) {
                const { PRESENCE_SOURCES } = require('../src/presence/engine');
                if (!PRESENCE_SOURCES.has(sourceName)) {
                    console.error('--source must be one of: ' + Array.from(PRESENCE_SOURCES).join(', '));
                    process.exit(1);
                }
            }
            await runPresence({
                pollMs: interval === undefined ? undefined : interval * 1000,
                freshnessMs: fresh === undefined ? undefined : fresh * 1000,
                sourceName,
            });
            return;
        }

        case 'sync': {
            // Push decision lives in sync(): --push forces, --no-push suppresses,
            // otherwise remote.json autoPush drives it.
            const push = args.flags['no-push'] ? false : (args.flags.push ? true : undefined);
            const res = await sync({ offline, push });
            for (const [name, n] of Object.entries(res.added)) {
                console.log(name.padEnd(12) + ' +' + n);
            }
            console.log('total new records: ' + res.total
                + (res.pricing.live ? '' : '  (pricing: offline/stale table)'));
            for (const w of require('../src/budget').thresholdWarnings()) console.log(w);
            if (res.push) printPushResult(res.push);
            else if (res.pushError) {
                console.error('warning: auto-push failed: ' + res.pushError
                    + ' (records kept locally, will retry next sync)');
            }
            return;
        }

        case 'log': {
            const f = args.flags;
            if (!f.agent || !f.model || (!f.input && !f.output)) {
                console.error('need --agent, --model and --input/--output');
                process.exit(1);
            }
            const ts = f.ts || new Date().toISOString();
            const rec = {
                ts,
                agent: String(f.agent),
                model: String(f.model),
                provider: String(f.provider || ''),
                input: Number(f.input || 0),
                output: Number(f.output || 0),
                cacheRead: Number(f['cache-read'] || 0),
                cacheWrite: Number(f['cache-write'] || 0),
            };
            rec.id = 'manual:' + rec.agent + ':' + ts + ':' + Math.random().toString(36).slice(2, 8);
            const pricing = await getPricing({ offline });
            const { costFor } = require('../src/pricing');
            const { cost, priced } = costFor(pricing.table, rec.model, rec.provider, rec);
            store.append([{ ...rec, cost, priced }]);
            console.log('recorded: ' + rec.agent + ' / ' + rec.model
                + '  in=' + rec.input + ' out=' + rec.output
                + '  cost=$' + cost.toFixed(4) + (priced ? '' : ' (no pricing found)'));
            return;
        }

        case 'subsidy': {
            const subs = require('../src/subscriptions');
            if (args.flags.set) {
                const fees = {};
                for (const pair of String(args.flags.set).split(',')) {
                    const m = pair.trim().match(/^([a-z0-9_]+)\.([a-z0-9_]+)=(-?\d+(?:\.\d+)?)$/i);
                    if (!m) { console.error('bad --set "' + pair + '" (want provider.plan=USD)'); process.exit(1); }
                    (fees[m[1]] = fees[m[1]] || {})[m[2]] = Number(m[3]);
                }
                const cfg = subs.saveConfig({ fees });
                console.log('saved fees to ' + subs.SUBS_FILE);
                console.log(JSON.stringify(cfg.fees, null, 2));
                return;
            }
            if (!args.flags['no-sync']) await sync({ offline });
            const period = args._[1] || 'month';
            const lastDays = args.flags.last ? Math.floor(Number(args.flags.last)) : 0;
            const r = subs.subsidy(period === 'day' ? 'today' : period, { lastDays });
            if (args.flags.json) console.log(JSON.stringify(r, null, 2));
            else console.log(subs.renderSubsidy(r));
            return;
        }

        case 'budget': {
            const budget = require('../src/budget');
            let touched = false;
            if (args.flags.clear) { budget.saveBudget({ monthly: null }); touched = true; }
            if (args.flags['clear-daily']) { budget.saveBudget({ daily: null }); touched = true; }
            if (args.flags.set !== undefined) {
                const n = Number(args.flags.set);
                if (!Number.isFinite(n) || n <= 0) {
                    console.error('--set needs a positive monthly budget in USD, e.g. --set 200');
                    process.exit(1);
                }
                budget.saveBudget({ monthly: n });
                touched = true;
            }
            if (args.flags['set-daily'] !== undefined) {
                const n = Number(args.flags['set-daily']);
                if (!Number.isFinite(n) || n <= 0) {
                    console.error('--set-daily needs a positive daily ceiling in USD, e.g. --set-daily 25');
                    process.exit(1);
                }
                budget.saveBudget({ daily: n });
                touched = true;
            }
            const b = budget.loadBudget();
            if (touched) console.log('saved (' + budget.BUDGET_FILE + ')');
            console.log(b.monthly
                ? 'monthly ceiling: $' + b.monthly.toFixed(2) + '  (tt month shows % consumed; --forecast projects)'
                : 'monthly ceiling: not set — tt budget --set 200');
            console.log(b.daily
                ? 'daily ceiling:   $' + b.daily.toFixed(2)
                : 'daily ceiling:   not set — tt budget --set-daily 25');
            if (!b.monthly && !b.daily) console.log('(ceilings warn on tt sync and reports when crossed)');
            return;
        }

        case 'reprice': {
            const { reprice } = require('../src/reprice');
            const dryRun = !!args.flags['dry-run'];
            const r = await reprice({ offline, dryRun, force: !!args.flags.force });
            if (r.aborted) {
                console.error('pricing table is offline/stale — recompute could zero out costs for models missing from the fallback table.');
                console.error('re-run online, or add --dry-run to preview, or --force to override.');
                process.exit(1);
            }
            const sign = r.delta >= 0 ? '+' : '-';
            console.log((dryRun ? '[dry-run] ' : '')
                + r.records + ' records across ' + r.files + ' files; ' + r.changed + ' changed');
            console.log('total: $' + r.oldTotal.toFixed(4) + ' -> $' + r.newTotal.toFixed(4)
                + '  (' + sign + '$' + Math.abs(r.delta).toFixed(4) + ')');
            if (r.nowPriced || r.lostPricing) {
                console.log('pricing: +' + r.nowPriced + ' newly priced, ' + r.lostPricing + ' lost pricing');
            }
            if (!r.pricing.live) console.log('(pricing: offline/stale table)');
            if (dryRun && r.changed) console.log('run without --dry-run to write changes');
            return;
        }

        case 'export': {
            const exp = require('../src/export');
            const PERIODS = new Set(['today', 'day', 'week', 'month', 'year', 'all', 'last']);
            const GROUPINGS = new Set(['agent', 'model', 'agent-model', 'project', 'day', 'month']);
            const word = args._[1] || 'month';
            if (!PERIODS.has(word)) {
                console.error('unknown period: ' + word + ' (today|week|month|year|all|last)');
                process.exit(1);
            }
            const by = args.flags.by || 'agent-model';
            if (!args.flags.records && !GROUPINGS.has(by)) {
                console.error('unknown grouping: ' + by + ' (agent|model|agent-model|project|day|month)');
                process.exit(1);
            }
            let lastDays = args.flags.last ? Math.floor(Number(args.flags.last)) : 0;
            if (word === 'last' && !(lastDays > 0)) lastDays = 7;
            if (args.flags.last && !(lastDays > 0)) {
                console.error('--last needs a positive number of days');
                process.exit(1);
            }
            if (!args.flags['no-sync']) await sync({ offline });
            const period = word === 'day' ? 'today' : word;
            const opts = { lastDays, period };
            // --ledger: lossless raw-record JSONL for multi-machine merge (BL-119).
            // Ignores --md/--records/--by (it is the native store shape).
            if (args.flags.ledger) {
                const recs = exp.ledger(period, opts);
                const out = exp.toJsonl(recs);
                if (args.flags.out) {
                    require('fs').writeFileSync(String(args.flags.out), out + '\n');
                    console.error('wrote ' + recs.length + ' records to ' + args.flags.out);
                } else {
                    console.log(out);
                }
                return;
            }
            const data = args.flags.records ? exp.records(period, opts) : exp.aggregate(period, by, opts);
            const out = (args.flags.md ? exp.toMd : exp.toCsv)(data);
            if (args.flags.out) {
                require('fs').writeFileSync(String(args.flags.out), out + '\n');
                console.error('wrote ' + data.rows.length + ' rows to ' + args.flags.out);
            } else {
                console.log(out);
            }
            return;
        }

        case 'import': {
            const { importLedger } = require('../src/import');
            const files = args._.slice(1);
            if (!files.length) {
                console.error('need at least one ledger file, e.g. tt import laptop.jsonl');
                process.exit(1);
            }
            const fs = require('fs');
            for (const f of files) {
                if (!fs.existsSync(f)) { console.error('no such file: ' + f); process.exit(1); }
            }
            const dryRun = !!args.flags['dry-run'];
            const r = importLedger(files, { dryRun });
            console.log((dryRun ? '[dry-run] ' : '')
                + r.total + ' records in ' + r.files + ' file(s); '
                + r.added + ' new, ' + r.duplicate + ' duplicate'
                + (r.invalid ? ', ' + r.invalid + ' invalid (skipped)' : ''));
            if (dryRun && r.added) console.log('run without --dry-run to merge them in');
            return;
        }

        case 'reproject': {
            const { backfillProjects } = require('../src/backfill');
            const dryRun = !!args.flags['dry-run'];
            const r = backfillProjects({ dryRun });
            console.log((dryRun ? '[dry-run] ' : '')
                + r.records + ' claude-code records; ' + r.patched + ' attributed'
                + (r.alreadyHad ? ', ' + r.alreadyHad + ' already had a project' : '')
                + (r.unmatched ? ', ' + r.unmatched + ' unmatched (transcript gone)' : ''));
            console.log('(matched against ' + r.mapped + ' request ids in on-disk transcripts)');
            if (dryRun && r.patched) console.log('run without --dry-run to write changes');
            return;
        }

        case 'agents': {
            for (const c of COLLECTORS) console.log(c.name);
            console.log('\ninbox for other agents: ' + ROOT + '/inbox/  (drop .jsonl files, see README)');
            return;
        }

        case 'pricing': {
            const p = await getPricing({ refresh: !!args.flags.refresh, offline });
            const age = p.fetchedAt ? Math.round((Date.now() - p.fetchedAt) / 60000) : null;
            console.log('source:  ' + SOURCE_URL);
            console.log('models:  ' + Object.keys(p.table).length);
            console.log('fetched: ' + (age === null ? 'never (builtin fallback only)' : age + ' min ago'));
            return;
        }

        case 'today':
        case 'day':
        case 'week':
        case 'month':
        case 'year':
        case 'last':
        case 'all': {
            if (!args.flags['no-sync']) await sync({ offline });
            const by = args.flags.by || 'agent-model';
            let lastDays = args.flags.last ? Math.floor(Number(args.flags.last)) : 0;
            if (cmd === 'last' && !(lastDays > 0)) lastDays = 7; // `tt last` defaults to 7 days
            if (args.flags.last && !(lastDays > 0)) {
                console.error('--last needs a positive number of days');
                process.exit(1);
            }
            const { loadBudget } = require('../src/budget');
            const period = cmd === 'day' ? 'today' : cmd;
            const efficiency = !!args.flags.efficiency;
            // cache-savings counterfactual needs per-model rates; null table → savings omitted
            const pricingTable = efficiency ? (await getPricing({ offline })).table : null;
            const opts = {
                lastDays,
                trend: !!args.flags.trend,
                compact: !!args.flags.compact,
                forecast: !!args.flags.forecast,
                efficiency,
                pricingTable,
                vsLast: args.flags.vs === 'last' || args.flags.vs === true,
                period,
                budget: loadBudget().monthly || 0,
            };
            const r = report(period, by, opts);
            if (args.flags.json) {
                console.log(JSON.stringify(r, null, 2));
            } else {
                console.log(render(r, by, opts));
                const { thresholdWarnings } = require('../src/budget');
                const warns = thresholdWarnings();
                if (warns.length) console.log('\n' + warns.join('\n'));
            }
            return;
        }

        case 'login': {
            if (args.flags.github) {
                const { loadRemote, loginWithGithubDevice } = require('../src/remote');
                const existing = loadRemote();
                const endpoint = args.flags.endpoint || (existing && existing.endpoint);
                if (!endpoint) {
                    console.error('need --endpoint <URL>, e.g. tt login --github --endpoint https://tt.example.com');
                    process.exit(1);
                }
                await loginWithGithubDevice({
                    endpoint,
                    autoPush: !!args.flags['auto-push'],
                    log: (m) => console.log(m),
                });
                return;
            }
            const token = args._[1];
            if (!token) {
                console.error('usage: tt login <token> --endpoint <URL>  OR  tt login --github --endpoint <URL>');
                process.exit(1);
            }
            const endpoint = args.flags.endpoint;
            if (!endpoint) {
                console.error('need --endpoint <URL>, e.g. tt login <token> --endpoint https://tt.example.com');
                process.exit(1);
            }
            const { saveRemote } = require('../src/remote');
            saveRemote({ token, endpoint: String(endpoint).replace(/\/$/, ''), autoPush: !!args.flags['auto-push'] });
            console.log('saved remote config (remote.json)');
            console.log('endpoint: ' + endpoint);
            if (args.flags['auto-push']) console.log('auto-push: on');
            return;
        }

        case 'push': {
            const { push } = require('../src/remote');
            const since = args.flags.since != null ? String(args.flags.since) : undefined;
            printPushResult(await push({ since }));
            return;
        }

        case 'remote': {
            const sub = args._[1];
            if (sub === 'status' || !sub) {
                const { remoteStatus } = require('../src/remote');
                const s = remoteStatus();
                if (!s.configured) {
                    console.log('remote: not configured — run tt login <token> --endpoint <URL>');
                } else {
                    console.log('endpoint: ' + s.endpoint);
                    console.log('auto-push: ' + (s.autoPush ? 'on' : 'off'));
                    console.log('last push: ' + (s.pushedAt || 'never'));
                }
            } else if (sub === 'auto-push') {
                const value = args._[2];
                if (value !== 'on' && value !== 'off') {
                    console.error('usage: tt remote auto-push on|off');
                    process.exit(1);
                }
                const { loadRemote, saveRemote } = require('../src/remote');
                const cfg = loadRemote();
                if (!cfg) {
                    console.error('no remote configured — run tt login <token> --endpoint <URL>');
                    process.exit(1);
                }
                saveRemote({ ...cfg, autoPush: value === 'on' });
                console.log('auto-push: ' + value);
            } else {
                console.error('unknown remote subcommand: ' + sub + ' (try: tt remote status)');
                process.exit(1);
            }
            return;
        }

        default:
            console.error('unknown command: ' + cmd + '\n');
            console.log(HELP);
            process.exit(1);
    }
}

main().catch((err) => {
    console.error('error: ' + (err && err.message ? err.message : err));
    process.exit(1);
});
