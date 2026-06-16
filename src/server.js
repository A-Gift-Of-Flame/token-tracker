'use strict';

// Local dev server: `tt serve` — HTML dashboard + JSON API over the stored
// data. On-demand process (Ctrl-C to stop), not a daemon: it never outlives the
// foreground process. A sync runs at startup, on the dashboard's Sync button
// (POST /api/sync), and on a refresh interval while the server is up (default
// 60s; `--interval 0` disables). The timer is unref'd so it never keeps the
// process alive on its own.

const http = require('http');
const { report } = require('./report');
const { sync } = require('./collectors');
const subs = require('./subscriptions');

const PERIODS = new Set(['today', 'week', 'month', 'year', 'all']);
const GROUPINGS = new Set(['agent', 'model', 'agent-model', 'project', 'day', 'month']);

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(null); } });
        req.on('error', () => resolve(null));
    });
}

const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>token-tracker</title>
<style>
  :root {
    --canvas:#e6e3dc; --panel:#d4d0c6; --paper:#f1efe9; --ink:#14130f;
    --ink-dim:#5a5752; --rule-faint:#14130f1a; --flag:#b8401a;
    --pos:#4a7a3a; --neg:#b8401a;
  }
  @media (prefers-color-scheme: dark) {
    :root { --canvas:#0f0f0d; --panel:#1a1a16; --paper:#050504; --ink:#d6d2c6;
      --ink-dim:#807b6f; --rule-faint:#d6d2c61f; --flag:#e89028; --pos:#8bbf6b; --neg:#e89028; }
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 system-ui, -apple-system, sans-serif; margin: 0; background: var(--canvas); color: var(--ink); }
  .wrap { max-width: 60rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { border-bottom: 1px solid var(--ink); padding-bottom: .8rem; margin-bottom: 1.5rem; }
  h1 { font-family: ui-monospace, monospace; font-size: 1.4rem; letter-spacing: -.02em; margin: 0; }
  h1 .dot { color: var(--flag); }
  #label { color: var(--ink-dim); font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; }
  h2 { font-family: ui-monospace, monospace; font-size: .8rem; text-transform: uppercase; letter-spacing: .1em;
       color: var(--ink-dim); margin: 0 0 .8rem; border-bottom: 1px solid var(--rule-faint); padding-bottom: .35rem; }
  section { margin-top: 2.5rem; }
  nav { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; margin: 1.2rem 0; }
  button, select { font: inherit; font-size: .85rem; padding: .35rem .8rem; border: 1px solid var(--ink-dim);
    border-radius: 0; background: var(--paper); color: var(--ink); cursor: pointer; }
  button:hover, select:hover { border-color: var(--flag); }
  nav .chip { font-family: ui-monospace, monospace; text-transform: lowercase; }
  nav .chip.active { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
  .spacer { flex: 1; }
  #syncmsg, #savemsg { color: var(--ink-dim); font-size: .8rem; margin-left: .5rem; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .8rem; margin: 1.2rem 0; }
  .kpi { background: var(--panel); border: 1px solid var(--rule-faint); border-left: 3px solid var(--flag); padding: .7rem .9rem; }
  .kpi .k { font-family: ui-monospace, monospace; font-size: .65rem; text-transform: uppercase; letter-spacing: .1em; color: var(--ink-dim); }
  .kpi .v { font-family: ui-monospace, monospace; font-size: 1.5rem; line-height: 1.2; margin-top: .15rem; }
  .kpi .v.pos { color: var(--pos); } .kpi .v.neg { color: var(--neg); }
  .chart { background: var(--panel); border: 1px solid var(--rule-faint); padding: 1rem; }
  .chart svg { display: block; width: 100%; height: auto; }
  .bar { fill: var(--flag); }
  .bar.dim { fill: var(--ink-dim); opacity: .45; }
  .axis { stroke: var(--rule-faint); stroke-width: 1; }
  .axislbl { fill: var(--ink-dim); font-family: ui-monospace, monospace; font-size: 9px; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { padding: .4rem .6rem; text-align: right; border-bottom: 1px solid var(--rule-faint); white-space: nowrap; }
  th { font-family: ui-monospace, monospace; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim); font-weight: 400; }
  th:first-child, td:first-child { text-align: left; }
  td.mono { font-family: ui-monospace, monospace; }
  tr.total td { font-weight: 600; border-top: 1px solid var(--ink); border-bottom: none; }
  td.pos { color: var(--pos); } td.neg { color: var(--neg); }
  .sharebar { display: inline-block; height: .55rem; background: var(--flag); border-radius: 0; vertical-align: middle; min-width: 1px; }
  .covwrap { margin: 1rem 0 1.4rem; display: grid; gap: .5rem; }
  .cov { display: grid; grid-template-columns: 9rem 1fr auto; gap: .6rem; align-items: center; font-size: .85rem; }
  .cov .name { font-family: ui-monospace, monospace; }
  .cov .track { position: relative; height: 1.1rem; background: var(--paper); border: 1px solid var(--rule-faint); }
  .cov .fee { position: absolute; top: 0; bottom: 0; left: 0; background: var(--ink-dim); opacity: .5; }
  .cov .spend { position: absolute; top: 0; bottom: 0; left: 0; background: var(--flag); opacity: .85; }
  .cov .val { font-family: ui-monospace, monospace; color: var(--pos); }
  .hint { color: var(--ink-dim); font-size: .82rem; }
  .fees { margin-top: 1rem; display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; }
  .fee label { display: block; font-family: ui-monospace, monospace; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim); margin-bottom: .2rem; }
  .fee input { font: inherit; font-family: ui-monospace, monospace; width: 6rem; padding: .3rem .5rem; border: 1px solid var(--ink-dim); background: var(--paper); color: var(--ink); text-align: right; }
</style>
<div class="wrap">
<header>
  <h1>token<span class="dot">·</span>tracker <span id="label" class="mono"></span></h1>
</header>
<nav>
  <span id="periods"></span>
  <select id="by">
    <option value="agent-model">agent + model</option>
    <option value="agent">agent</option>
    <option value="model">model</option>
    <option value="project">project</option>
    <option value="day">day</option>
    <option value="month">month</option>
  </select>
  <span class="spacer"></span>
  <button id="sync">Sync</button><span id="syncmsg"></span>
</nav>

<div class="kpis" id="kpis"></div>

<section>
  <h2>Daily cost</h2>
  <div class="chart" id="dailychart"></div>
</section>

<section>
  <h2>Usage breakdown</h2>
  <table id="out"></table>
</section>

<section id="subs">
  <h2>Subscription subsidy</h2>
  <div class="hint">How much each flat-rate plan beats metered API for this period.
    Net = API-equivalent spend − fee prorated to the period; coverage = spend ÷ prorated fee.</div>
  <div class="covwrap" id="covbars"></div>
  <table id="subsout"></table>
  <div class="hint" id="crossover"></div>
  <div class="fees" id="fees"></div>
  <div style="margin-top:.8rem"><button id="savefees">Save fees</button><span id="savemsg"></span></div>
</section>
</div>

<script>
const PERIODS = ['today', 'week', 'month', 'year', 'all'];
let period = 'today';

const fmtNum = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const fmtCost = c => c == null ? '—' : (c < 0 ? '-' : '') + (Math.abs(c) === 0 ? '$0.00'
  : Math.abs(c) < 0.01 ? '<$0.01' : '$' + Math.abs(c).toFixed(2));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const nav = document.getElementById('periods');
for (const p of PERIODS) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = p;
  b.onclick = () => { period = p; load(); };
  nav.appendChild(b);
}

const sign = c => c == null ? '' : c >= 0 ? 'pos' : 'neg';
const tr = (cells, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '>'
  + cells.map(c => typeof c === 'object'
      ? '<td class="' + (c.cls || '') + '">' + c.v + '</td>'
      : '<td>' + c + '</td>').join('') + '</tr>';

// hand-rolled SVG bar chart (zero-dep). data: [{label, value}]
function barChart(data) {
  if (!data.length) return '<div class="hint">no data for this period</div>';
  const W = 720, H = 150, padB = 18, padL = 4;
  const max = Math.max(...data.map(d => d.value), 0) || 1;
  const n = data.length, gap = n > 60 ? 1 : 2;
  const bw = Math.max(1, (W - padL - (n - 1) * gap) / n);
  const bars = data.map((d, i) => {
    const h = (d.value / max) * (H - padB);
    const x = padL + i * (bw + gap);
    return '<rect class="bar" x="' + x.toFixed(1) + '" y="' + (H - padB - h).toFixed(1)
      + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '"><title>'
      + esc(d.label) + ' — ' + fmtCost(d.value) + '</title></rect>';
  }).join('');
  // first/last day labels
  const lbl = (i, anchor) => '<text class="axislbl" x="' + (padL + i * (bw + gap)).toFixed(1)
    + '" y="' + (H - 5) + '" text-anchor="' + anchor + '">' + esc(data[i].label.slice(5)) + '</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">'
    + '<line class="axis" x1="0" y1="' + (H - padB) + '" x2="' + W + '" y2="' + (H - padB) + '"/>'
    + bars + lbl(0, 'start') + (n > 1 ? lbl(n - 1, 'end') : '') + '</svg>';
}

function kpi(k, v, cls) {
  return '<div class="kpi"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';
}

async function load() {
  for (const b of nav.children) b.classList.toggle('active', b.textContent === period);
  const by = document.getElementById('by').value;
  const [r, daily, sub] = await Promise.all([
    fetch('/api/' + period + '?by=' + encodeURIComponent(by)).then(x => x.json()),
    fetch('/api/' + period + '?by=day').then(x => x.json()),
    fetch('/api/subsidy?period=' + period).then(x => x.json()),
  ]);
  document.getElementById('label').textContent = r.label;

  // KPIs
  document.getElementById('kpis').innerHTML =
    kpi('API spend', fmtCost(r.total.cost))
    + kpi('requests', fmtNum(r.total.requests))
    + kpi('net subsidy', fmtCost(sub.totals.net), sign(sub.totals.net))
    + kpi('coverage', sub.totals.coverage == null ? '—' : sub.totals.coverage.toFixed(1) + 'x');

  // daily chart
  document.getElementById('dailychart').innerHTML =
    barChart(daily.rows.map(d => ({ label: d.key, value: d.cost })));

  // breakdown table with inline share bars
  const maxCost = Math.max(...r.rows.map(g => g.cost), 0) || 1;
  const cells = g => [{ v: esc(g.key), cls: 'mono' }, g.requests, fmtNum(g.input), fmtNum(g.output),
    fmtNum(g.cacheRead), fmtNum(g.cacheWrite),
    { v: fmtCost(g.cost) + ' <span class="sharebar" style="width:' + (g.cost / maxCost * 60).toFixed(1) + 'px"></span>' }];
  document.getElementById('out').innerHTML =
    '<tr>' + [by, 'reqs', 'input', 'output', 'cache r', 'cache w', 'cost']
      .map(h => '<th>' + h + '</th>').join('') + '</tr>'
    + r.rows.map(g => tr(cells(g))).join('')
    + tr([{ v: 'TOTAL' }, r.total.requests, fmtNum(r.total.input), fmtNum(r.total.output),
        fmtNum(r.total.cacheRead), fmtNum(r.total.cacheWrite), { v: fmtCost(r.total.cost) }], 'total');

  renderSubsidy(sub);
}

function renderSubsidy(r) {
  // coverage bars: prorated fee vs API spend per subscription
  const subsRows = r.rows.filter(s => s.proratedFee != null);
  const maxSpend = Math.max(...subsRows.map(s => Math.max(s.spend, s.proratedFee)), 0) || 1;
  document.getElementById('covbars').innerHTML = subsRows.map(s => {
    const feeW = (s.proratedFee / maxSpend * 100).toFixed(1);
    const spendW = (s.spend / maxSpend * 100).toFixed(1);
    return '<div class="cov"><span class="name">' + esc(s.agent) + ' · ' + esc(s.plan || '?') + '</span>'
      + '<div class="track"><div class="fee" style="width:' + feeW + '%"></div>'
      + '<div class="spend" style="width:' + spendW + '%"></div></div>'
      + '<span class="val">' + (s.coverage == null ? '—' : s.coverage.toFixed(1) + 'x') + '</span></div>';
  }).join('') || '<span class="hint">no subscription plan detected for an active agent.</span>';

  const cells = s => [{ v: esc(s.agent), cls: 'mono' }, esc(s.plan || '—'),
    fmtCost(s.monthlyFee), fmtCost(s.proratedFee), fmtCost(s.spend),
    { v: fmtCost(s.net), cls: sign(s.net) },
    s.coverage == null ? '—' : s.coverage.toFixed(1) + 'x'];
  const t = r.totals;
  document.getElementById('subsout').innerHTML =
    '<tr>' + ['agent', 'plan', '$/mo', 'fee (' + r.days + 'd)', 'API spend', 'net subsidy', 'coverage']
      .map(h => '<th>' + h + '</th>').join('') + '</tr>'
    + r.rows.map(s => tr(cells(s))).join('')
    + tr([{ v: 'TOTAL' }, '', '', fmtCost(t.proratedFee), fmtCost(t.spend),
        { v: fmtCost(t.net), cls: sign(t.net) }, t.coverage == null ? '—' : t.coverage.toFixed(1) + 'x'], 'total');

  const x = t.crossover;
  document.getElementById('crossover').innerHTML = !x ? '' :
    '<strong>Crossover:</strong> burn ' + fmtCost(x.dailyBurn) + '/day vs '
    + fmtCost(x.crossoverDaily) + '/day break-even (= $' + x.monthlyFee.toFixed(2) + '/mo flat fee) — '
    + (x.breakEvenDays == null ? 'no usage'
        : (x.verdict === 'flat'
            ? 'flat plan wins, fees earned back in ' + x.breakEvenDays.toFixed(1) + 'd'
            : 'metered would be cheaper (' + x.breakEvenDays.toFixed(1) + 'd to earn back one month of fees)'));
}

async function loadFees() {
  const r = await (await fetch('/api/subscriptions')).json();
  const detected = Object.values(r.plans).filter(p => p && p.plan);
  const seen = new Set();
  const fields = [];
  for (const p of detected) {
    const key = p.provider + '.' + p.plan;
    if (seen.has(key)) continue;
    seen.add(key);
    const val = (r.fees[p.provider] && r.fees[p.provider][p.plan]) || 0;
    fields.push('<div class="fee"><label>' + esc(p.provider) + ' / ' + esc(p.plan) + ' ($/mo)</label>'
      + '<input type="number" min="0" step="1" data-prov="' + esc(p.provider) + '" data-plan="' + esc(p.plan) + '" value="' + val + '"></div>');
  }
  document.getElementById('fees').innerHTML = fields.join('')
    || '<span class="hint">no subscription plan detected for an active agent.</span>';
}

document.getElementById('savefees').onclick = async () => {
  const fees = {};
  for (const inp of document.querySelectorAll('#fees input')) {
    (fees[inp.dataset.prov] = fees[inp.dataset.prov] || {})[inp.dataset.plan] = Number(inp.value);
  }
  await fetch('/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fees }) });
  const msg = document.getElementById('savemsg');
  msg.textContent = 'saved'; setTimeout(() => msg.textContent = '', 1500);
  load();
};

document.getElementById('by').onchange = load;
document.getElementById('sync').onclick = async () => {
  const msg = document.getElementById('syncmsg');
  msg.textContent = 'syncing…';
  const r = await (await fetch('/api/sync', { method: 'POST' })).json();
  msg.textContent = '+' + r.total + ' new';
  load();
};
load();
loadFees();

// Live refresh: re-pull while the tab is visible so the server-side auto-sync
// shows up without a manual reload. Paused when the tab is hidden; refreshes
// once on becoming visible again. POLL_MS is injected from the server interval.
const POLL_MS = __POLL_MS__;
if (POLL_MS > 0) {
  setInterval(() => { if (!document.hidden) { load(); loadFees(); } }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); loadFees(); } });
}
</script>
</html>
`;

function createServer({ offline = false, interval = 60 } = {}) {
    // Client poll cadence mirrors the server-side auto-sync; 0 disables both.
    const html = PAGE.replace('__POLL_MS__', String(interval > 0 ? interval * 1000 : 0));
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/sync') {
                const r = await sync({ offline });
                json(res, 200, { added: r.added, total: r.total });
                return;
            }
            if (url.pathname === '/api/subscriptions') {
                if (req.method === 'GET') {
                    return json(res, 200, { fees: subs.loadConfig().fees, plans: subs.detectPlans() });
                }
                if (req.method === 'POST') {
                    const body = await readBody(req);
                    if (!body || !body.fees) return json(res, 400, { error: 'expected { fees: {...} }' });
                    return json(res, 200, { fees: subs.saveConfig(body).fees });
                }
            }
            if (req.method === 'GET' && url.pathname === '/api/subsidy') {
                const period = url.searchParams.get('period') || 'month';
                const lastDays = Number(url.searchParams.get('last') || 0) || 0;
                if (!lastDays && !PERIODS.has(period === 'day' ? 'today' : period)) {
                    return json(res, 404, { error: 'unknown period: ' + period });
                }
                return json(res, 200, subs.subsidy(period === 'day' ? 'today' : period, { lastDays }));
            }
            const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
            if (req.method === 'GET' && m) {
                const period = m[1] === 'day' ? 'today' : m[1];
                const by = url.searchParams.get('by') || 'agent-model';
                if (!PERIODS.has(period)) return json(res, 404, { error: 'unknown period: ' + m[1] });
                if (!GROUPINGS.has(by)) return json(res, 400, { error: 'unknown grouping: ' + by });
                json(res, 200, report(period, by));
                return;
            }
            json(res, 404, { error: 'not found' });
        } catch (err) {
            json(res, 500, { error: err && err.message ? err.message : String(err) });
        }
    });
}

// Sync once at startup, bind to localhost only, print the URL.
async function serve({ port = 7777, offline = false, interval = 60 } = {}) {
    try { await sync({ offline }); } catch { /* serve stored data anyway */ }
    const server = createServer({ offline, interval });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    const actual = server.address().port;
    let timer = null;
    if (interval > 0) {
        timer = setInterval(() => {
            sync({ offline })
                .then((r) => {
                    if (r.pushError) console.error('auto-push failed: ' + r.pushError + ' (will retry next sync)');
                })
                .catch(() => { /* keep serving stored data */ });
        }, interval * 1000);
        timer.unref(); // never keep the process alive on the timer alone
        server.once('close', () => clearInterval(timer));
    }
    const auto = interval > 0 ? '  (auto-sync ' + interval + 's)' : '';
    console.log('token-tracker dev server: http://127.0.0.1:' + actual + auto + '  (Ctrl-C to stop)');
    return server;
}

module.exports = { serve, createServer };
