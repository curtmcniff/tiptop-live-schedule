// Tarping decision log: one entry per truck decision, kept on the phone, sent by the "Send log" mail.
// Format: Tarping_Log_dwnld\tools\DESIGN.md sections 1, 2 and 7. Dependency-free UMD: browser global
// TarpingLog, Node module.exports. The single definition of the format (the back-office parser requires it).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TarpingLog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1; // mail line 1 reads "TARPLOG v" + VERSION
  var HEADER = 'id,sender,po,kill,catch,truck,rec,fin,ovr,reason,topRec,topFin,perCoop,coldF,loc,hour,rain,fc,crewSent,fsWas,dataAt';
  var FIELDS = HEADER.split(',');
  var POSITIONS = ['D', 'P', 'T', 'F', 'R']; // driver side, passenger side, top, front (nose), rear
  var POSITION_NAMES = { D: 'driver', P: 'pass', T: 'top', F: 'front', R: 'rear' };
  var CARRIED = { L: 3, H: 3 }; // what a trailer holds: the most any layout may use
  var REASON_MAX = 120;
  var KEY = 'tarpLog.v1';
  var DEFAULT_TO = 'curt.mcniff@tiptopfoods.com';
  var HOUR = 3600000, DAY = 86400000;

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function stamp(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
  function isoMin(d) { return ymd(d) + 'T' + hm(d); }

  // ---------- layout: "D:H/P:LL/T:L", "-" = no tarp ----------
  // Returns { ok, error, positions: { D: { H, L } }, heavy, light, text } (text = canonical form).
  function parseLayout(s) {
    var bad = function (m) { return { ok: false, error: m, positions: {}, heavy: 0, light: 0, text: null }; };
    if (typeof s !== 'string') return bad('not text');
    s = s.trim();
    if (!s) return bad('empty');
    var positions = {}, heavy = 0, light = 0;
    if (s !== '-') {
      var parts = s.split('/');
      for (var i = 0; i < parts.length; i++) {
        var m = /^([DPTFR]):([HL]+)$/.exec(parts[i].trim());
        if (!m) return bad('bad position "' + parts[i] + '"');
        if (positions[m[1]]) return bad('position ' + m[1] + ' twice');
        var h = (m[2].match(/H/g) || []).length, l = (m[2].match(/L/g) || []).length;
        positions[m[1]] = { H: h, L: l };
        heavy += h; light += l;
      }
    }
    if (heavy > CARRIED.H) return bad('more than ' + CARRIED.H + ' heavy');
    if (light > CARRIED.L) return bad('more than ' + CARRIED.L + ' light');
    return { ok: true, error: null, positions: positions, heavy: heavy, light: light, text: formatLayout(positions) };
  }
  // positions { D: { H, L } } -> canonical layout text (positions in D P T F R order, heavy letters first)
  function formatLayout(positions) {
    var out = [];
    POSITIONS.forEach(function (p) {
      var c = positions && positions[p];
      if (!c || !(c.H > 0 || c.L > 0)) return;
      out.push(p + ':' + new Array((c.H || 0) + 1).join('H') + new Array((c.L || 0) + 1).join('L'));
    });
    return out.length ? out.join('/') : '-';
  }
  function layoutCounts(s) {
    var r = parseLayout(s);
    return r.ok ? { heavy: r.heavy, light: r.light } : null;
  }

  // ---------- one entry line ----------
  function csvField(v) {
    v = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function formatEntry(e) {
    return FIELDS.map(function (f) { return csvField(e[f]); }).join(',');
  }
  function cleanReason(r) {
    return String(r || '').replace(new RegExp('[\r\n' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g'), ' ').trim().slice(0, REASON_MAX);
  }

  function newDeviceId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', i;
    var buf = null;
    try {
      var c = typeof crypto !== 'undefined' ? crypto : (typeof self !== 'undefined' ? self.crypto : null);
      if (c && c.getRandomValues) { buf = new Uint8Array(6); c.getRandomValues(buf); }
    } catch (e) { buf = null; }
    for (i = 0; i < 6; i++) out += chars.charAt((buf ? buf[i] : Math.floor(Math.random() * 256)) % chars.length);
    return out;
  }

  // ---------- the log (kept in a localStorage-like object, key tarpLog.v1) ----------
  function createLog(storage, opts) {
    opts = opts || {};
    var to = opts.to || DEFAULT_TO;
    var splitChars = opts.splitChars || 6000;
    var redAfterH = opts.redAfterHours || 12;
    var keepDays = opts.keepDays || 30;
    var resendDays = opts.resendDays || 7;
    var senders = opts.senders || ['Terry Fountain', 'Amber Avery'];
    var memory = null; // used when storage throws (private mode)

    function load() {
      var raw = null, st = null;
      try { raw = storage ? storage.getItem(KEY) : null; } catch (e) { raw = null; }
      if (raw) { try { st = JSON.parse(raw); } catch (e) { st = null; } }
      if (!st && memory) st = memory;
      if (!st || typeof st !== 'object') st = {};
      if (!Array.isArray(st.entries)) st.entries = [];
      if (!/^[a-z0-9]{6}$/.test(st.deviceId || '')) st.deviceId = opts.deviceId || newDeviceId();
      if (typeof st.sender !== 'string') st.sender = '';
      return st;
    }
    function save(st) {
      memory = st;
      try { if (storage) storage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* kept in memory */ }
    }
    function view(en) { // a copy, so callers cannot change the stored entry
      return { id: en.id, ts: en.ts, f: JSON.parse(JSON.stringify(en.f)), sentBatch: en.sentBatch || '', sentAt: en.sentAt || '' };
    }

    function getSender() { return load().sender; }
    function setSender(name) {
      if (senders.indexOf(name) === -1) throw new Error('unknown sender');
      var st = load(); st.sender = name; save(st);
    }

    // fields: every column of HEADER except id, sender and ovr (set here). Throws on an invalid layout.
    function addEntry(fields, now) {
      now = now || new Date();
      var st = load();
      if (!st.sender) throw new Error('sender not chosen');
      var rec = parseLayout(fields.rec), fin = parseLayout(fields.fin);
      if (!rec.ok) throw new Error('rec: ' + rec.error);
      if (!fin.ok) throw new Error('fin: ' + fin.error);
      if (!/^PO-\d+$/.test(String(fields.po || ''))) throw new Error('bad PO');
      var ts = now.getTime(), id, taken = {};
      st.entries.forEach(function (en) { taken[en.id] = true; });
      do { id = st.deviceId + '-' + stamp(new Date(ts)).replace(/^(\d{8})/, '$1T'); ts += 1000; } while (taken[id]);
      ts -= 1000;
      var f = {};
      FIELDS.forEach(function (k) { f[k] = fields[k] === undefined || fields[k] === null ? '' : String(fields[k]); });
      f.id = id;
      f.sender = st.sender;
      f.rec = rec.text;
      f.fin = fin.text;
      f.ovr = rec.text === fin.text ? 'N' : 'Y';
      f.reason = cleanReason(fields.reason);
      var en = { id: id, ts: ts, f: f, sentBatch: '', sentAt: '' };
      st.entries.push(en);
      save(st);
      return view(en);
    }

    function entries() { return load().entries.map(view).sort(function (a, b) { return a.ts - b.ts; }); }
    function unsent() { return entries().filter(function (e) { return !e.sentAt; }); }
    function unsentCount() { return unsent().length; }
    function isRed(now) {
      now = (now || new Date()).getTime();
      return unsent().some(function (e) { return now - e.ts > redAfterH * HOUR; });
    }
    // texted-to-crew stamp for entries not sent yet (a sent entry is already at the back office)
    function setCrewSent(ids, when) {
      var st = load(), n = 0;
      st.entries.forEach(function (en) {
        if (!en.sentAt && ids.indexOf(en.id) !== -1) { en.f.crewSent = when; n++; }
      });
      if (n) save(st);
      return n;
    }

    // The mail: line 1 TARPLOG header, the CSV header, entry lines, END line; CRLF; parts of at most
    // splitChars characters (JS length, before URL encoding); an entry is never split.
    function buildBatch(list, now) {
      now = now || new Date();
      var st = load(), n = list.length;
      var sender = st.sender || (n && list[0].f.sender) || '';
      var batchId = st.deviceId + '-' + stamp(now);
      var lines = list.map(function (e) { return formatEntry(e.f); });
      // size the header / END overhead for the widest possible counts, so no part can overshoot
      var wide = 'TARPLOG v' + VERSION + ' batch=' + batchId + ' part=99/99 entries=9999/9999 sender=' + sender +
        '\r\n' + HEADER + '\r\n' + '\r\nEND batch=' + batchId + ' part=99/99';
      var groups = [], cur = [], size = wide.length;
      lines.forEach(function (ln, i) {
        if (cur.length && size + 2 + ln.length > splitChars) { groups.push(cur); cur = []; size = wide.length; }
        cur.push(i); size += 2 + ln.length;
      });
      if (cur.length) groups.push(cur);
      var m = groups.length;
      var subj = 'Tarping Log ' + sender + ' ' + ymd(now) + ' ' + hm(now) + ' batch ' + batchId + ' (' + n + ' entries)';
      var parts = groups.map(function (g, gi) {
        var k = gi + 1;
        var body = ['TARPLOG v' + VERSION + ' batch=' + batchId + ' part=' + k + '/' + m + ' entries=' + g.length + '/' + n + ' sender=' + sender, HEADER]
          .concat(g.map(function (i) { return lines[i]; }), ['END batch=' + batchId + ' part=' + k + '/' + m]).join('\r\n');
        var subject = subj + (m > 1 ? ' part ' + k + ' of ' + m : '');
        var q = '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
        return {
          k: k, m: m, subject: subject, body: body,
          mailto: 'mailto:' + to + q,
          // the same mail opened straight in the Outlook app (its compose link), for phones whose default mail app
          // holds a personal account: the flow only takes Send-log mail from company addresses (2026-11-25)
          outlook: 'ms-outlook://compose?to=' + to + q.replace('?', '&'),
          ids: g.map(function (i) { return list[i].id; })
        };
      });
      return { batchId: batchId, n: n, sender: sender, to: to, parts: parts };
    }

    function markSent(ids, batchId, now) {
      var st = load(), at = isoMin(now || new Date()), c = 0;
      st.entries.forEach(function (en) {
        if (ids.indexOf(en.id) !== -1) { en.sentBatch = batchId; en.sentAt = at; c++; }
      });
      if (c) save(st);
      return c;
    }
    // sent entries older than keepDays go; unsent entries are never pruned
    function prune(now) {
      var st = load(), cut = (now || new Date()).getTime() - keepDays * DAY, before = st.entries.length;
      st.entries = st.entries.filter(function (en) { return !en.sentAt || en.ts >= cut; });
      if (st.entries.length !== before) save(st);
      return before - st.entries.length;
    }
    // every entry of the last 7 days, sent or not, as a new batch (same entry ids; the master dedupes)
    function resendBatch(now) {
      now = now || new Date();
      var cut = now.getTime() - resendDays * DAY;
      return buildBatch(entries().filter(function (e) { return e.ts >= cut; }), now);
    }

    return {
      senders: senders.slice(), getSender: getSender, setSender: setSender, addEntry: addEntry, entries: entries,
      unsent: unsent, unsentCount: unsentCount, isRed: isRed, setCrewSent: setCrewSent, buildBatch: buildBatch,
      markSent: markSent, prune: prune, resendBatch: resendBatch
    };
  }

  return {
    VERSION: VERSION, HEADER: HEADER, FIELDS: FIELDS, POSITIONS: POSITIONS, POSITION_NAMES: POSITION_NAMES, CARRIED: CARRIED,
    REASON_MAX: REASON_MAX, KEY: KEY, parseLayout: parseLayout, formatLayout: formatLayout, layoutCounts: layoutCounts,
    csvField: csvField, formatEntry: formatEntry, createLog: createLog, isoMin: isoMin
  };
});
