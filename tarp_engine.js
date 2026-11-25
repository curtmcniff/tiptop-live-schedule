// Pure tarping-recommendation functions. All values come from the rules object (tarp_rules.json).
// One file for both places (v19, Curt 2026-11-25: the phone fetches its own forecast): Node requires it
// (run.js, tests), and the phone app loads an identical copy as site\tarp_engine.js (browser global TarpEngine).
// Change it here, then copy it to dev_tarping\site\tarp_engine.js; the engine test and every app build compare the
// copies.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TarpEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const POS_ORDER = ['driver', 'pass', 'top', 'front', 'rear'];
const POS_LETTER = { driver: 'D', pass: 'P', top: 'T', front: 'F', rear: 'R' };
const POS_TEXT = { driver: 'driver', pass: 'passenger', top: 'top', front: 'front', rear: 'rear' };

// ---------- local-time helpers (Georgia wall clock, "yyyy-mm-ddThh:mm") ----------
const pad = (n) => String(n).padStart(2, '0');
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) throw new Error('bad local time ' + s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
function fmtLocal(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const addMinutes = (s, min) => fmtLocal(parseLocal(s) + Math.round(min) * 60000);
// Excel serial (already Georgia local) -> "yyyy-mm-ddThh:mm"
function serialToLocal(serial) {
  if (serial == null || serial === '' || isNaN(serial)) return null;
  return fmtLocal(Math.round((Number(serial) - 25569) * 1440) * 60000);
}
const dateOf = (s) => s.slice(0, 10);
function addDays(ymd, n) { return fmtLocal(parseLocal(ymd) + n * 86400000).slice(0, 10); }
function gaNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  let off = '';
  try { off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(now).find((x) => x.type === 'timeZoneName').value.replace('GMT', '') || '+00:00'; } catch (e) { off = ''; } // older phones: no offset
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hhmm: `${p.hour}${p.minute}`, local: `${date}T${p.hour}:${p.minute}`, iso: `${date}T${p.hour}:${p.minute}:${p.second}${off}` };
}

// ---------- rules ----------
function sumPos(positions) {
  let light = 0, heavy = 0;
  for (const v of Object.values(positions || {})) { light += v.light || 0; heavy += v.heavy || 0; }
  return { light, heavy };
}
function validateRules(rules) {
  const errors = [];
  const inv = rules && rules.inventory, car = rules && rules.carried;
  if (!inv || !car) return { ok: false, errors: ['inventory / carried missing'] };
  if (car.L < inv.L || car.H < inv.H) errors.push('carried below inventory');
  if (!Array.isArray(rules.rules) || !rules.rules.length) return { ok: false, errors: errors.concat('no rules') };
  for (const r of rules.rules) {
    for (const cond of ['dry', 'rain']) {
      const b = r[cond], tag = `${r.category} ${cond}`;
      if (!b) { errors.push(`${tag}: missing`); continue; }
      if (b.light > inv.L) errors.push(`${tag}: ${b.light} light exceeds inventory ${inv.L}`);
      if (b.heavy > inv.H) errors.push(`${tag}: ${b.heavy} heavy exceeds inventory ${inv.H}`);
      for (const k of Object.keys(b.positions || {})) if (!POS_ORDER.includes(k)) errors.push(`${tag}: unknown position ${k}`);
      const s = sumPos(b.positions);
      if (s.light !== b.light) errors.push(`${tag}: position lights ${s.light} != total ${b.light}`);
      if (s.heavy !== b.heavy) errors.push(`${tag}: position heavies ${s.heavy} != total ${b.heavy}`);
    }
  }
  for (let t = -60; t <= 130; t++) {
    const n = rules.rules.filter((r) => (r.min == null || t >= r.min) && (r.max == null || t <= r.max)).length;
    if (n !== 1) { errors.push(`temperature ${t}F matches ${n} categories`); break; }
  }
  return { ok: errors.length === 0, errors };
}
function categorize(rules, tempF) {
  const t = Math.round(tempF);
  const rule = rules.rules.find((r) => (r.min == null || t >= r.min) && (r.max == null || t <= r.max));
  if (!rule) throw new Error('no category for ' + t);
  return rule;
}

// ---------- layout / text ----------
function layoutOf(rec) {
  const parts = [];
  for (const k of POS_ORDER) {
    const v = rec.positions && rec.positions[k];
    if (!v || (!v.heavy && !v.light)) continue;
    parts.push(`${POS_LETTER[k]}:${'H'.repeat(v.heavy || 0)}${'L'.repeat(v.light || 0)}`);
  }
  return parts.length ? parts.join('/') : '-';
}
function textOf(rec, rules) {
  const names = (rules && rules.sms && rules.sms.positions) || {};
  const parts = [];
  for (const k of POS_ORDER) {
    const v = rec.positions && rec.positions[k];
    if (!v || (!v.heavy && !v.light)) continue;
    // words, not H / L (Curt 2026-11-25: "show light or heavy for planning")
    const q = [v.heavy ? `${v.heavy} heavy` : null, v.light ? `${v.light} light` : null].filter(Boolean).join(' + ');
    parts.push(`${q} ${(names[k] && names[k].en) || POS_TEXT[k]}`);
  }
  return parts.length ? parts.join(' / ') : 'No tarps';
}

// ---------- recommendation ----------
function recommend(rules, { coldF, highF, rain }) {
  const t = Math.round(coldF);
  const high = highF == null ? t : Math.round(highF);
  const rule = categorize(rules, t);
  const condition = rain ? 'rain' : 'dry';
  const b = rule[condition];
  const positions = {};
  for (const [k, v] of Object.entries(b.positions || {})) positions[k] = { light: v.light || 0, heavy: v.heavy || 0 };
  let light = b.light, heavy = b.heavy, warmDrop = false;
  if (b.warmDropTopF != null && high - t >= b.warmDropTopF && positions.top && positions.top.light > 0) {
    positions.top.light -= 1; light -= 1; warmDrop = true;
    if (!positions.top.light && !positions.top.heavy) delete positions.top;
  }
  const rec = { light, heavy, positions };
  return { category: rule.category, condition, rec, layout: layoutOf(rec), text: textOf(rec, rules), note: b.note || null, warmDrop, topRowCheck: !!b.topRowCheck };
}

// ---------- top row ----------
function topRow(rules, heads) {
  const tr = rules.trailer;
  if (!heads || heads <= 0) return null;
  const planned = Math.round(heads / tr.coopsTotal);
  const required = Math.ceil(heads / (tr.coopsTotal - tr.coopsTopTier));
  if (required <= planned + tr.maxBumpPerCoop) {
    let line = `Load ${required}/coop, top row empty`;
    const flagged = required > tr.stdBirdsPerCoop;
    if (flagged) line += ` - above standard ${tr.stdBirdsPerCoop}/coop - Terry confirms`;
    return { heads, planned, required, line, flagged };
  }
  return { heads, planned, required, line: `Top row cannot be emptied at +${tr.maxBumpPerCoop}/coop`, flagged: false };
}

// ---------- window ----------
// in: { arrive, leave ("yyyy-mm-ddThh:mm"), transitMin, miles, estMiles }
function truckWindow(rules, { arrive, leave, transitMin, miles, estMiles }) {
  const problems = [];
  let transitH = null, transitSrc = null;
  if (transitMin > 0) { transitH = transitMin / 60; transitSrc = 'fs'; }
  else if (miles > 0) { transitH = miles / rules.mph; transitSrc = 'miles'; }
  else if (estMiles > 0) { transitH = estMiles / rules.mph; transitSrc = 'miles'; problems.push('transit estimated from straight-line distance'); }
  if (transitH == null) return { window: null, problems: problems.concat('no transit time or miles') };
  const transitMinutes = Math.round(transitH * 60);
  let start = arrive;
  if (!start) {
    if (!leave) return { window: null, problems: problems.concat('no arrive or leave time') };
    start = addMinutes(leave, transitMinutes);
    problems.push('arrive blank - window estimated from leave + transit');
  }
  const farmLeave = addMinutes(start, rules.loadingHours * 60);
  const end = addMinutes(farmLeave, transitMinutes);
  return { window: { start, farmLeave, end, transitH: Math.round(transitH * 100) / 100, transitSrc }, problems };
}

// ---------- weather over the window ----------
// points: [{ name, weather: { time[], temperature_2m[], precipitation_probability[] } | null }]
function analyzeWeather(rules, window, points) {
  const s = parseLocal(window.start), e = parseLocal(window.end);
  let cold = null, high = null, rainPct = null;
  const per = []; // per point over the window (Curt 2026-11-24: Terry sees farm, midpoint and plant, not only the lowest)
  for (const p of points) {
    if (!p.weather) continue;
    const { time, temperature_2m: T, precipitation_probability: P } = p.weather;
    let pLow = null, pHigh = null, pRain = null;
    for (let i = 0; i < time.length; i++) {
      const h = parseLocal(time[i]);
      if (!(h < e && h + 3600000 > s)) continue; // hour [h, h+1) intersects the window
      const t = T[i], pr = P ? P[i] : null;
      if (t != null) {
        if (cold == null || t < cold.t) cold = { t, point: p.name, hour: time[i], prob: pr };
        if (high == null || t > high) high = t;
        if (pLow == null || t < pLow.t) pLow = { t, hour: time[i] };
        if (pHigh == null || t > pHigh) pHigh = t;
      }
      if (pr != null && (rainPct == null || pr > rainPct)) rainPct = pr;
      if (pr != null && (pRain == null || pr > pRain)) pRain = pr;
    }
    if (pLow) per.push({ name: p.name, lowF: Math.round(pLow.t), lowAt: pLow.hour, highF: Math.round(pHigh), rainPct: pRain == null ? 0 : pRain });
  }
  if (!cold) return null;
  return {
    coldF: Math.round(cold.t), coldAt: { point: cold.point, hour: cold.hour }, coldProb: cold.prob,
    highF: Math.round(high), rainPct: rainPct == null ? 0 : rainPct, rain: rainPct != null && rainPct >= rules.rainProbPct,
    points: per,
  };
}

// ---------- overrides (never more than carried; beyond inventory needs a reason) ----------
function checkOverride(rules, rec) {
  const s = sumPos(rec.positions);
  const errors = [];
  if (s.light > rules.carried.L) errors.push('more than carried light');
  if (s.heavy > rules.carried.H) errors.push('more than carried heavy');
  return { ok: !errors.length, errors, needsReason: s.heavy > rules.inventory.H || s.light > rules.inventory.L };
}

return { POS_ORDER, validateRules, categorize, recommend, topRow, layoutOf, textOf, truckWindow, analyzeWeather, checkOverride, serialToLocal, addMinutes, addDays, dateOf, parseLocal, fmtLocal, gaNow };
});
