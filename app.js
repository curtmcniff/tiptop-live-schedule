(function () {
  'use strict';

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var STALE_HOURS = 36;
  var REFETCH_MS = 10 * 60 * 1000;

  var $ = function (id) { return document.getElementById(id); };
  var state = { data: null, offline: false, weekIdx: 0, query: '', lastFetch: 0, firstRender: true, loading: false, filters: null,
    view: 'schedule', dquery: '', dcompany: '' };

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function parseDate(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function fmtDay(s) {
    var d = parseDate(s);
    return d ? DOW[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate() : '—';
  }
  function fmtNum(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '—';
  }
  function dash(v) { return v === null || v === undefined || v === '' ? '—' : String(v); }
  function etToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  }
  function fmtPhone(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : String(p || '');
  }
  function digits(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : null;
  }
  function cmp(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'en', { sensitivity: 'base' });
  }
  // distinct non-empty values of one field across a PO's trucks, in first-seen order, with counts
  function distinct(list, key) {
    var out = [], idx = {};
    list.forEach(function (t) {
      var v = t && t[key];
      if (!v) return;
      if (idx[v] === undefined) { idx[v] = out.length; out.push({ name: v, count: 0 }); }
      out[idx[v]].count++;
    });
    return out;
  }
  function hasFlag(po, code) {
    return (po.flags || []).some(function (f) { return f && f.code === code; });
  }
  // "8 POs (2 draft)" - same total as the week tab shows
  function countLabel(list) {
    var drafts = list.filter(function (p) { return p.draft; }).length, n = list.length;
    return n + (n === 1 ? ' PO' : ' POs') + (drafts ? ' (' + drafts + ' draft)' : '');
  }

  // ---------- filters (producer / complex / catcher / breeder manager) ----------
  // Kept per phone in localStorage, so a crew lead's or a complex's choice is there next time.
  // They apply on top of the week tabs and the search box.
  var FILTER_KEY = 'ttls.filters';
  var NONE = '__none__'; // POs with no catcher / no breeder manager on file
  var FILTERS = [
    { key: 'plant', id: 'f-plant' },          // Curt 2026-11-24: all POs for New Market, Marietta or Tyson
    { key: 'producer', id: 'f-producer' },
    { key: 'complex', id: 'f-complex' },
    { key: 'catcher', id: 'f-catcher', none: 'No catcher yet' },
    { key: 'bm', id: 'f-bm', none: 'No breeder mgr on file' }
  ];
  function noneLabel(f) { return f.none || 'None'; }
  function blankFilters() {
    var o = {};
    FILTERS.forEach(function (f) { o[f.key] = ''; });
    return o;
  }
  function loadFilters() {
    var f = null;
    try { f = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch (e) { f = null; }
    f = f || {};
    var o = blankFilters();
    FILTERS.forEach(function (x) { if (f[x.key]) o[x.key] = String(f[x.key]); });
    return o;
  }
  // breeder managers on file for the PO's complex (the same list the PO's Breeder manager rows show)
  function bmNames(po) {
    var cs = (state.data && state.data.contacts && state.data.contacts[po.complex]) || [];
    return cs.map(function (c) { return c && c.name; }).filter(Boolean);
  }
  function saveFilters() {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters)); } catch (e) { /* private mode */ }
  }
  function filtersOn() {
    return FILTERS.some(function (f) { return !!state.filters[f.key]; });
  }
  function poValues(po, key) {
    if (key === 'catcher') return po.crew && po.crew.length ? po.crew : [NONE];
    if (key === 'bm') { var b = bmNames(po); return b.length ? b : [NONE]; }
    return po[key] ? [po[key]] : [];
  }
  // true when the PO passes every chosen filter; `skip` leaves one out (to list that filter's own choices)
  function passesWith(po, filters, skip) {
    return FILTERS.every(function (f) {
      var v = filters[f.key];
      return !v || f.key === skip || poValues(po, f.key).indexOf(v) !== -1;
    });
  }
  function passes(po, skip) { return passesWith(po, state.filters, skip); }
  // each list offers only values that still have POs under the other three choices (all weeks)
  function renderFilters() {
    var pos = state.data.pos;
    FILTERS.forEach(function (f) {
      var sel = $(f.id), cur = state.filters[f.key], seen = {}, names = [];
      pos.forEach(function (po) {
        if (!passes(po, f.key)) return;
        poValues(po, f.key).forEach(function (v) {
          if (!seen[v]) { seen[v] = true; names.push(v); }
        });
      });
      if (cur && !seen[cur]) names.push(cur); // a saved choice with no POs right now stays visible
      names.sort(function (a, b) { return a === NONE ? 1 : b === NONE ? -1 : cmp(a, b); });
      sel.textContent = '';
      var all = el('option', null, 'All');
      all.value = '';
      sel.appendChild(all);
      names.forEach(function (v) {
        var o = el('option', null, v === NONE ? noneLabel(f) : v);
        o.value = v;
        sel.appendChild(o);
      });
      sel.value = cur;
      sel.classList.toggle('on', !!cur);
    });
  }
  function setMatches(text, on) {
    var m = $('matches');
    m.textContent = '';
    if (!text) { m.hidden = true; return; }
    m.hidden = false;
    var span = el('span');
    if (on) {
      // full names, since a narrow phone cuts them off inside the dropdowns
      var names = FILTERS.filter(function (f) { return !!state.filters[f.key]; })
        .map(function (f) { var v = state.filters[f.key]; return v === NONE ? noneLabel(f) : v; });
      span.appendChild(el('b', 'fnames', names.join(' · ')));
    }
    span.appendChild(document.createTextNode(text));
    m.appendChild(span);
    if (on) {
      var b = el('button', 'clearf', 'Clear filters');
      b.type = 'button';
      b.addEventListener('click', function () {
        state.filters = blankFilters();
        saveFilters();
        render();
      });
      m.appendChild(b);
    }
  }

  // ---------- data loading ----------
  function valid(d) {
    return d && d.schema === 1 && Array.isArray(d.weeks) && Array.isArray(d.pos) &&
      d.contacts && typeof d.contacts === 'object';
  }

  // ---------- access codes ----------
  // data.json is encrypted (see Build-PhoneData.ps1): AES-256-CBC + HMAC-SHA256 under a data key
  // that is wrapped once per access code (PBKDF2-SHA256). A phone types its code ONCE; the
  // code-derived key is kept in localStorage, so later visits (and offline use) open silently.
  // A revoked code's slot disappears from the next data.json, and the phone is asked again.
  var ACCESS_KEY = 'ttls.access';
  function b64d(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function b64e(u) { var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function joinBytes(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function openBox(key64, box) {
    var sub = crypto.subtle, iv = b64d(box.iv), ct = b64d(box.ct);
    return sub.importKey('raw', key64.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      .then(function (mk) { return sub.verify('HMAC', mk, b64d(box.tag), joinBytes(iv, ct)); })
      .then(function (ok) {
        if (!ok) return null;
        return sub.importKey('raw', key64.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt'])
          .then(function (ak) { return sub.decrypt({ name: 'AES-CBC', iv: iv }, ak, ct); })
          .then(function (pt) { return new Uint8Array(pt); });
      });
  }
  function codeKey(code, saltB64, iter) {
    var sub = crypto.subtle;
    return sub.importKey('raw', new TextEncoder().encode(normCode(code)), 'PBKDF2', false, ['deriveBits'])
      .then(function (base) { return sub.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations: iter }, base, 512); })
      .then(function (bits) { return new Uint8Array(bits); });
  }
  function getAccess() {
    try { var a = JSON.parse(localStorage.getItem(ACCESS_KEY) || 'null'); return a && a.slot && a.k ? a : null; } catch (e) { return null; }
  }
  function setAccess(a) {
    try { if (a) localStorage.setItem(ACCESS_KEY, JSON.stringify(a)); else localStorage.removeItem(ACCESS_KEY); } catch (e) { /* private mode */ }
  }
  // decrypted data object, or null when this phone's key does not open this copy
  function openData(enc, access) {
    var slot = (enc.slots || []).filter(function (s) { return s.id === access.slot; })[0];
    if (!slot) return Promise.resolve(null);
    return openBox(b64d(access.k), slot).then(function (dataKey) {
      if (!dataKey) return null;
      return openBox(dataKey, enc).then(function (pt) { return pt ? JSON.parse(new TextDecoder().decode(pt)) : null; });
    }).catch(function () { return null; });
  }
  function tryCode(enc, code) {
    var n = normCode(code), id = n.slice(0, 2);
    var slot = (enc.slots || []).filter(function (s) { return s.id === id; })[0];
    if (n.length !== 14 || !slot) return Promise.resolve(null);
    return codeKey(n, slot.salt, (enc.kdf && enc.kdf.iter) || 300000).then(function (k) {
      var access = { slot: id, k: b64e(k) };
      return openData(enc, access).then(function (d) { return d ? { d: d, access: access } : null; });
    });
  }

  // ---------- data loading ----------
  function accept(d, fromCache) {
    if (!valid(d)) throw new Error('bad data');
    var first = !state.data;
    // same copy as on screen: only refresh the banners, so open rows stay open
    var same = !first && state.data.builtAt === d.builtAt && state.data.asOf === d.asOf;
    state.data = d;
    state.locked = false;
    state.offline = fromCache;
    state.lastFetch = Date.now();
    if (first) state.weekIdx = defaultWeek();
    if (same) updateBanners(); else render();
  }

  function load(manual) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    $('refresh').classList.add('spin');
    return fetch('data.json', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var fromCache = res.headers.get('X-From-Cache') === '1';
        return res.json().then(function (d) { return { d: d, fromCache: fromCache }; });
      })
      .then(function (r) {
        if (!r.d || !r.d.enc) { state.enc = null; return accept(r.d, r.fromCache); }   // unencrypted: local test fixture only
        state.enc = r.d;
        state.offline = r.fromCache;
        var access = getAccess();
        if (!access) { showLock(''); return; }
        return openData(r.d, access).then(function (plain) {
          if (plain) return accept(plain, r.fromCache);
          setAccess(null);
          showLock('Access on this phone has changed. Enter your access code again.');
        });
      })
      .catch(function () {
        state.offline = true;
        if (state.data) updateBanners(); else if (!state.locked) render();
      })
      .then(function () {
        state.loading = false;
        $('refresh').classList.remove('spin');
      });
  }

  function defaultWeek() {
    var t = etToday(), weeks = state.data.weeks, i;
    for (i = 0; i < weeks.length; i++) {
      if (weeks[i].start <= t && t <= weeks[i].end) return i;
    }
    for (i = 0; i < weeks.length; i++) if (weeks[i].kind === 'current') return i;
    return 0;
  }

  // ---------- rendering ----------
  function render() {
    var d = state.data;
    var main = $('main');
    main.textContent = '';
    $('offline').hidden = !state.offline;
    if (!d) {
      $('updated').textContent = 'No data';
      tarpBarRefresh();
      $('stale').hidden = true;
      $('tabs').hidden = true;
      $('searchwrap').hidden = true;
      $('views').hidden = true;
      $('dirwrap').hidden = true;
      main.appendChild(el('div', 'msg',
        state.offline
          ? 'No schedule data available. You appear to be offline and no saved copy exists yet. Connect to the internet and tap ↻.'
          : 'Loading schedule…'));
      syncSticky();
      return;
    }
    updateBanners();

    $('views').hidden = false;
    $('v-schedule').setAttribute('aria-selected', String(state.view !== 'directory'));
    $('v-directory').setAttribute('aria-selected', String(state.view === 'directory'));
    if (state.view === 'directory') {
      $('tabs').hidden = true;
      $('searchwrap').hidden = true;
      $('dirwrap').hidden = false;
      renderDirectory(main);
      addForget(main);
      syncSticky();
      return;
    }
    $('dirwrap').hidden = true;
    $('tabs').hidden = false;
    $('searchwrap').hidden = false;
    var on = filtersOn();
    renderTabs(on);
    renderFilters();

    var q = state.query.trim().toLowerCase();
    var list;
    if (q) {
      list = d.pos.filter(function (po) {
        return passes(po) && [po.grower, po.complex, po.producer, po.id].concat(po.crew || [], bmNames(po)).some(function (v) {
          return v && String(v).toLowerCase().indexOf(q) !== -1;
        });
      });
      setMatches(list.length + (list.length === 1 ? ' match' : ' matches') + (on ? ' (filtered)' : ''), on);
      renderDays(main, list, null, q, on);
    } else {
      var w = d.weeks[state.weekIdx];
      list = w ? d.pos.filter(function (po) { return po.kill >= w.start && po.kill <= w.end && passes(po); }) : [];
      setMatches(on ? countLabel(list) + ' this week' : '', on);
      renderDays(main, list, w, '', on);
    }
    addForget(main);
    syncSticky();
    if (state.firstRender) {
      state.firstRender = false;
      var t = main.querySelector('.day-hdr.today');
      if (t) t.scrollIntoView({ block: 'start' });
    }
  }

  function addForget(main) {
    if (!state.enc) return;
    var forget = el('button', 'forget', 'Remove access from this phone');
    forget.type = 'button';
    forget.addEventListener('click', function () {
      if (window.confirm('Remove access from this phone? The access code will be needed again.')) { setAccess(null); location.reload(); }
    });
    main.appendChild(forget);
  }

  // ---------- directory: every contact in the Power Apps contacts export ----------
  // Each card has Call / Text / Email buttons and, when the person is tied to POs in the seven
  // weeks, a "N POs" button that opens the schedule filtered to them: a breeder manager by the
  // Breeder Mgr filter, anyone else by their Complex, else by their Company (= the PO's Producer).
  function normKey(s) { return String(s || '').replace(/'/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  // a name without its quoted nickname: Samuel "Andy" Edwards = Samuel Edwards
  function dirKey(s) { return normKey(String(s || '').replace(/"[^"]*"/g, ' ').replace(/\([^)]*\)/g, ' ')); }
  var linkCache = { data: null };
  function linkIndex() {
    var d = state.data;
    if (linkCache.data === d) return linkCache;
    var bm = {}, cx = {}, prod = {}, mail = {};
    Object.keys(d.contacts || {}).forEach(function (complex) {
      (d.contacts[complex] || []).forEach(function (c) { if (c && c.name && !bm[dirKey(c.name)]) bm[dirKey(c.name)] = c.name; });
    });
    d.pos.forEach(function (po) {
      if (po.complex) cx[normKey(po.complex)] = po.complex;
      if (po.producer) prod[normKey(po.producer)] = po.producer;
    });
    (Array.isArray(d.directory) ? d.directory : []).forEach(function (c) {
      if (c && c.name && c.email && !mail[dirKey(c.name)]) mail[dirKey(c.name)] = c.email;
    });
    linkCache = { data: d, bm: bm, cx: cx, prod: prod, mail: mail, links: {} };
    return linkCache;
  }
  function contactLink(c) {
    var ix = linkIndex(), id = dirKey(c.name) + '|' + normKey(c.complex) + '|' + normKey(c.company);
    if (ix.links[id] !== undefined) return ix.links[id];
    var link = null, k = dirKey(c.name);
    if (ix.bm[k]) link = { key: 'bm', value: ix.bm[k] };
    else if (c.complex && ix.cx[normKey(c.complex)]) link = { key: 'complex', value: ix.cx[normKey(c.complex)] };
    else if (c.company && ix.prod[normKey(c.company)]) link = { key: 'producer', value: ix.prod[normKey(c.company)] };
    if (link) {
      var f = blankFilters();
      f[link.key] = link.value;
      link.count = state.data.pos.filter(function (po) { return passesWith(po, f); }).length;
      if (!link.count) link = null;
    }
    ix.links[id] = link;
    return link;
  }
  // open the schedule filtered to one contact; stay on the open week if it has any of their POs,
  // else go to the first week from this one on (then earlier) that has
  function showPos(link) {
    state.filters = blankFilters();
    state.filters[link.key] = link.value;
    saveFilters();
    state.query = '';
    $('search').value = '';
    state.view = 'schedule';
    var weeks = state.data.weeks;
    function count(i) {
      var w = weeks[i];
      return state.data.pos.filter(function (po) { return po.kill >= w.start && po.kill <= w.end && passes(po); }).length;
    }
    if (!weeks[state.weekIdx] || !count(state.weekIdx)) {
      var cur = defaultWeek(), pick = -1, i;
      for (i = cur; i < weeks.length && pick < 0; i++) if (count(i)) pick = i;
      for (i = cur - 1; i >= 0 && pick < 0; i--) if (count(i)) pick = i;
      if (pick >= 0) state.weekIdx = pick;
    }
    render();
    window.scrollTo(0, 0);
  }
  function linkBtn(label, href, cls, aria) {
    var a = el('a', 'btn' + (cls ? ' ' + cls : ''), label);
    a.href = href;
    if (aria) a.setAttribute('aria-label', aria);
    return a;
  }
  function dirCard(c) {
    var card = el('div', 'dcard');
    card.appendChild(el('div', 'nm', dash(c.name)));
    var sub = [c.title, c.complex].filter(Boolean).join(' · ');
    if (sub) card.appendChild(el('div', 'sub', sub));
    var m = digits(c.mobile), o = digits(c.office);
    if (o === m) o = null;
    var nums = [];
    if (m) nums.push('Mobile ' + fmtPhone(m));
    if (o) nums.push('Office ' + fmtPhone(o));
    if (nums.length) card.appendChild(el('div', 'nums', nums.join(' · ')));
    if (c.email) card.appendChild(el('div', 'nums', c.email));
    var b = el('div', 'dbtns'), who = c.name || '';
    if (m || o) b.appendChild(linkBtn('Call', 'tel:+1' + (m || o), '', 'Call ' + who + (m ? ' mobile' : ' office')));
    if (m) b.appendChild(linkBtn('Text', 'sms:+1' + m, 'text', 'Text ' + who));
    if (c.email) b.appendChild(linkBtn('Email', 'mailto:' + c.email, 'mail', 'Email ' + who));
    if (m && o) b.appendChild(linkBtn('Office', 'tel:+1' + o, '', 'Call ' + who + ' office'));
    var link = contactLink(c);
    if (link) {
      var p = el('button', 'btn pos', link.count + (link.count === 1 ? ' PO' : ' POs'));
      p.type = 'button';
      p.setAttribute('aria-label', 'Show the ' + link.count + ' POs for ' + who);
      p.addEventListener('click', function () { showPos(link); });
      b.appendChild(p);
    }
    if (b.childNodes.length) card.appendChild(b);
    if (!m && !o && !c.email) card.appendChild(el('div', 'none', 'No phone or email on file'));
    return card;
  }
  function renderDirectory(main) {
    var all = Array.isArray(state.data.directory) ? state.data.directory.slice() : null;
    if (!all) {
      $('dirwrap').hidden = true;
      main.appendChild(el('div', 'msg', 'The directory comes with the next schedule update. Tap ↻ when you have signal.'));
      return;
    }
    all.sort(function (a, b) {
      return (a.company ? 0 : 1) - (b.company ? 0 : 1) || cmp(a.company, b.company) || cmp(a.name, b.name);
    });
    // company list: always every company, so a choice can be changed without clearing first
    var sel = $('d-company'), cos = {}, names = [];
    all.forEach(function (c) { var k = c.company || NONE; if (!cos[k]) { cos[k] = true; names.push(k); } });
    if (state.dcompany && !cos[state.dcompany]) state.dcompany = '';
    sel.textContent = '';
    var o0 = el('option', null, 'All');
    o0.value = '';
    sel.appendChild(o0);
    names.forEach(function (k) {
      var o = el('option', null, k === NONE ? 'No company' : k);
      o.value = k;
      sel.appendChild(o);
    });
    sel.value = state.dcompany;
    sel.classList.toggle('on', !!state.dcompany);

    var q = state.dquery.trim().toLowerCase(), qd = q.replace(/\D/g, '');
    var list = all.filter(function (c) {
      if (state.dcompany && (c.company || NONE) !== state.dcompany) return false;
      if (!q) return true;
      if ([c.name, c.title, c.company, c.complex, c.role, c.email].some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; })) return true;
      // a caller's number, typed in any format
      return qd.length >= 3 && [c.mobile, c.office].some(function (p) { return p && String(p).replace(/\D/g, '').indexOf(qd) !== -1; });
    });

    var dm = $('dmatches'), on = !!(q || state.dcompany);
    dm.textContent = '';
    dm.hidden = false;
    dm.appendChild(el('span', null, list.length + (list.length === 1 ? ' contact' : ' contacts') + (on ? ' of ' + all.length : '')));
    if (on) {
      var clr = el('button', 'clearf', 'Clear');
      clr.type = 'button';
      clr.addEventListener('click', function () {
        state.dquery = '';
        state.dcompany = '';
        $('dsearch').value = '';
        render();
      });
      dm.appendChild(clr);
    }
    if (!list.length) {
      main.appendChild(el('div', 'msg', 'No contacts match.'));
      return;
    }
    var groups = [], gi = {};
    list.forEach(function (c) {
      var k = c.company || '';
      if (gi[k] === undefined) { gi[k] = groups.length; groups.push({ name: k, items: [] }); }
      groups[gi[k]].items.push(c);
    });
    groups.forEach(function (g) {
      var sec = el('section', 'dir-group');
      var h = el('div', 'dir-co');
      h.appendChild(el('span', null, g.name || 'No company'));
      h.appendChild(el('small', null, g.items.length + (g.items.length === 1 ? ' contact' : ' contacts')));
      sec.appendChild(h);
      g.items.forEach(function (c) { sec.appendChild(dirCard(c)); });
      main.appendChild(sec);
    });
  }

  // first visit on a phone (or access revoked): ask for the access code
  function showLock(message) {
    state.data = null;
    state.locked = true;
    var main = $('main');
    main.textContent = '';
    $('tabs').hidden = true; $('searchwrap').hidden = true; $('stale').hidden = true;
    $('views').hidden = true; $('dirwrap').hidden = true;
    $('offline').hidden = !state.offline;
    $('updated').textContent = 'Access code needed';
    tarpBarRefresh();
    var form = el('form', 'lock');
    form.appendChild(el('h2', null, 'Enter your access code'));
    form.appendChild(el('p', null, 'You only need to do this once on this phone. Codes come from Live Supply.'));
    var inp = el('input');
    inp.id = 'code'; inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.setAttribute('autocapitalize', 'characters'); inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('aria-label', 'Access code'); inp.placeholder = 'XX-XXXX-XXXX-XXXX';
    var btn = el('button', 'btn', 'Unlock');
    btn.type = 'submit';
    var msg = el('p', 'lockmsg', message || '');
    msg.setAttribute('role', 'status');
    form.appendChild(inp); form.appendChild(btn); form.appendChild(msg);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!state.enc) { msg.textContent = 'No schedule downloaded yet. Connect to the internet and tap ↻.'; return; }
      if (!window.crypto || !crypto.subtle) { msg.textContent = 'This browser cannot open the schedule. Use Safari (iPhone) or Chrome (Android).'; return; }
      btn.disabled = true;
      msg.textContent = 'Checking…';
      tryCode(state.enc, inp.value).then(function (res) {
        btn.disabled = false;
        if (!res) { msg.textContent = 'That code does not match. Check it and try again.'; return; }
        setAccess(res.access);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        state.firstRender = true;
        accept(res.d, state.offline);
      }).catch(function () {
        btn.disabled = false;
        msg.textContent = 'Could not check the code on this phone.';
      });
    });
    main.appendChild(form);
    syncSticky();
  }

  function updateBanners() {
    var d = state.data;
    $('offline').hidden = !state.offline;
    $('updated').textContent = 'Updated ' + (d.asOfLabel || '—');
    tarpBarRefresh();
    var stale = $('stale');
    var asOf = d.asOf ? new Date(d.asOf) : null;
    if (asOf && !isNaN(asOf)) {
      var hrs = (Date.now() - asOf.getTime()) / 3600000;
      if (hrs > STALE_HOURS) {
        stale.textContent = 'Data is ' + Math.round(hrs) + ' hours old';
        stale.hidden = false;
      } else stale.hidden = true;
    } else stale.hidden = true;
    syncSticky();
  }

  // The week tabs sit in a strip that scrolls sideways on a phone (seven weeks since 2026-11-23),
  // with a faded arrow at either end while there are more weeks that way.
  function tabStrip() {
    var nav = $('tabs'), strip = nav.querySelector('.strip');
    if (strip) return strip;
    nav.removeAttribute('role');
    strip = el('div', 'strip');
    strip.setAttribute('role', 'tablist');
    nav.appendChild(strip);
    [['l', '‹', 'Earlier weeks', -1], ['r', '›', 'Later weeks', 1]].forEach(function (a) {
      var m = el('button', 'more ' + a[0], a[1]);
      m.type = 'button'; m.hidden = true;
      m.setAttribute('aria-label', a[2]);
      m.addEventListener('click', function () {
        var by = a[3] * Math.max(120, strip.clientWidth * 0.7);
        if (strip.scrollBy) strip.scrollBy({ left: by, behavior: 'smooth' }); else strip.scrollLeft += by;
      });
      nav.appendChild(m);
    });
    strip.addEventListener('scroll', moreArrows, { passive: true });
    window.addEventListener('resize', moreArrows);
    return strip;
  }
  function moreArrows() {
    var nav = $('tabs'), strip = nav.querySelector('.strip');
    if (!strip) return;
    nav.querySelector('.more.l').hidden = strip.scrollLeft <= 2;
    nav.querySelector('.more.r').hidden = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
  }

  function renderTabs(on) {
    var nav = tabStrip();
    var keep = nav.scrollLeft;   // stay where the user left the strip
    nav.textContent = '';
    var names = { previous: 'Last wk', current: 'This wk', next: 'Next wk', after: 'Wk after', plus3: 'In 3 wks', plus4: 'In 4 wks', plus5: 'In 5 wks' };
    var picked = null;
    state.data.weeks.forEach(function (w, i) {
      var b = el('button', 'tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === state.weekIdx && !state.query.trim()));
      b.appendChild(el('b', null, names[w.kind] || 'Week'));
      b.appendChild(el('span', null, shortRange(w)));
      if (on) {
        // with a filter on, each tab shows how many of its POs match, so empty weeks are obvious
        var n = state.data.pos.filter(function (po) { return po.kill >= w.start && po.kill <= w.end && passes(po); }).length;
        b.appendChild(el('i', null, n + (n === 1 ? ' PO' : ' POs')));
      }
      b.addEventListener('click', function () {
        state.weekIdx = i;
        $('search').value = '';
        state.query = '';
        render();
        window.scrollTo(0, 0);
      });
      nav.appendChild(b);
      if (i === state.weekIdx && !state.query.trim()) picked = b;
    });
    nav.scrollLeft = keep;
    // keep the chosen week's tab in view and clear of the arrows (not scrollIntoView: that can
    // also move the page)
    if (picked) {
      var left = picked.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft, right = left + picked.offsetWidth;
      if (left - 46 < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 46);
      else if (right + 46 > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right + 46 - nav.clientWidth;
    }
    moreArrows();
  }

  function shortRange(w) {
    var a = parseDate(w.start), b = parseDate(w.end);
    if (!a || !b) return w.label || '';
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var s = M[a.getMonth()] + ' ' + a.getDate() + '–';
    s += (b.getMonth() !== a.getMonth() ? M[b.getMonth()] + ' ' : '') + b.getDate();
    return s;
  }

  function renderDays(main, list, week, q, filtered) {
    var byDay = {};
    list.forEach(function (po) { (byDay[po.kill] = byDay[po.kill] || []).push(po); });
    var days = [];
    if (week && !filtered) {
      var d = parseDate(week.start), end = parseDate(week.end);
      while (d && end && d <= end) {
        var k = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        if (d.getDay() !== 0 || byDay[k]) days.push(k);
        d.setDate(d.getDate() + 1);
      }
    } else {
      days = Object.keys(byDay).sort();
    }
    if (!days.length) {
      main.appendChild(el('div', 'msg', q ? 'No matches.' : filtered ? 'No POs this week match the filters.' : 'No POs for this week.'));
      return;
    }
    var today = etToday();
    // days start collapsed (Curt 2026-11-24); a search or filter opens them so the matches show
    var autoOpen = !!(q && String(q).trim()) || !!filtered;
    days.forEach(function (day) { main.appendChild(buildDay(day, byDay[day] || [], day === today, autoOpen)); });
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function buildDay(day, pos, isToday, autoOpen) {
    var sec = el('section', 'day');
    var live = pos.filter(function (p) { return !p.draft; });
    var drafts = pos.length - live.length;
    var head = live.reduce(function (s, p) { return s + (+p.head || 0); }, 0);

    var hdr = el('div', 'day-hdr' + (isToday ? ' today' : ''));
    var left = el(pos.length ? 'button' : 'div', pos.length ? 'day-open' : null);
    var chev = el('span', 'day-chev');
    var title = el('div', 'day-title');
    if (pos.length) { left.type = 'button'; title.appendChild(chev); }
    title.appendChild(document.createTextNode(fmtDay(day) + (isToday ? ' (today)' : '')));
    left.appendChild(title);
    var sum = live.length + (live.length === 1 ? ' PO' : ' POs') + ' · ' + fmtNum(head) + ' head';
    if (drafts) sum += ' + ' + drafts + ' draft';
    left.appendChild(el('div', 'day-sum', sum));
    hdr.appendChild(left);
    sec.appendChild(hdr);

    if (!pos.length) {
      sec.appendChild(el('div', 'nokills', 'No kills'));
      return sec;
    }
    pos.sort(function (a, b) {
      return cmp(a.plant, b.plant) || cmp(a.producer, b.producer) || cmp(a.complex, b.complex) || cmp(a.grower, b.grower);
    });
    var rows = pos.map(buildPo);
    var body = el('div', 'day-body');
    rows.forEach(function (r) { body.appendChild(r.node); });
    state.openDays = state.openDays || {};
    var open = autoOpen || !!state.openDays[day];
    function paintDay() {
      body.hidden = !open;
      chev.textContent = open ? '▾ ' : '▸ ';
      left.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    left.addEventListener('click', function () { open = !open; state.openDays[day] = open; paintDay(); });
    var toggle = el('button', 'day-toggle', 'Expand all');
    toggle.type = 'button';
    toggle.addEventListener('click', function () {
      var all = toggle.textContent === 'Expand all';
      if (all && !open) { open = true; state.openDays[day] = true; paintDay(); }
      rows.forEach(function (r) { r.set(all); });
      toggle.textContent = all ? 'Collapse all' : 'Expand all';
    });
    hdr.appendChild(toggle);
    sec.appendChild(body);
    paintDay();
    return sec;
  }

  function buildPo(po) {
    var node = el('div', 'po');
    var btn = el('button', 'po-head');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    var main = el('div', 'po-main');
    main.appendChild(el('div', 'po-l1', dash(po.producer) + ' · ' + dash(po.complex)));
    main.appendChild(el('div', 'po-l2', dash(po.grower)));
    var badges = el('div', 'badges');
    if (po.draft) badges.appendChild(el('span', 'badge', 'Draft'));
    if (hasFlag(po, 'resave')) badges.appendChild(el('span', 'badge resave', '⚠ Resave'));
    if (hasFlag(po, 'pattern')) badges.appendChild(el('span', 'badge pattern', 'Off-pattern'));
    if (badges.childNodes.length) main.appendChild(badges);
    btn.appendChild(main);
    var right = el('div', 'po-right');
    right.appendChild(el('div', 'head', fmtNum(po.head)));
    right.appendChild(el('div', 'plant', dash(po.plant)));
    btn.appendChild(right);
    btn.appendChild(el('span', 'chev', '›'));
    node.appendChild(btn);

    var body = null;
    function set(open) {
      btn.setAttribute('aria-expanded', String(open));
      if (open && !body) { body = buildBody(po); node.appendChild(body); }
      if (body) body.hidden = !open;
    }
    btn.addEventListener('click', function () {
      set(btn.getAttribute('aria-expanded') !== 'true');
    });
    return { node: node, set: set };
  }

  function buildBody(po) {
    var body = el('div', 'po-body');
    var dl = el('dl', 'fields');
    function row(k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
    row('PO', dash(po.id));
    row('Kill', fmtDay(po.kill));
    row('Catch', po.catch ? fmtDay(po.catch) + (po.catchTime ? ' ' + po.catchTime : '') : '—');
    row('Houses', dash(po.houses));
    row('Head', fmtNum(po.head));
    row('Plant', dash(po.plant) + (po.type && po.type !== 'Standard' ? ' (' + po.type + ')' : ''));
    row('Status', dash(po.status));
    row('Crew', po.crew && po.crew.length ? po.crew.join(', ') : '—');
    var loads = Array.isArray(po.loads) ? po.loads : [];
    var haulerNames = distinct(loads, 'hauler'), driverNames = distinct(loads, 'driver');
    row('Hauler', haulerNames.length ? haulerNames.map(function (h) { return h.name; }).join(', ') : '—');
    row('Trucks', dash(po.trucks || (loads.length || null)));
    row('Bloodwork', dash(po.bloodwork));
    body.appendChild(dl);

    (po.flags || []).forEach(function (f) {
      if (f && f.text) body.appendChild(el('div', 'flagbox', '⚠ ' + f.text));
    });

    if (tarpActive()) { var tsec = buildTarping(po); if (tsec) body.appendChild(tsec); }

    body.appendChild(el('div', 'sec-title', 'Breeder manager'));
    var cs = (state.data.contacts && state.data.contacts[po.complex]) || [];
    if (!cs.length) {
      body.appendChild(el('div', 'contact none', 'No breeder manager on file'));
    } else {
      cs.forEach(function (c) {
        var m = digits(c.mobile), o = digits(c.office);
        var em = c.email || linkIndex().mail[dirKey(c.name)] || null;
        body.appendChild(contactRow(c.name, c.title, m || o, m, m || o, em));
      });
    }

    body.appendChild(el('div', 'sec-title', 'Grower'));
    var gp = digits(po.growerPhone);
    body.appendChild(contactRow(dash(po.grower), null, gp, gp, gp));
    body.appendChild(addressRow(po.address, po.addressOk));

    if (po.crew && po.crew.length) {
      body.appendChild(el('div', 'sec-title', po.crew.length > 1 ? 'Catchers' : 'Catcher'));
      po.crew.forEach(function (name) {
        var c = (state.data.catchers && state.data.catchers[name]) || {};
        var m = digits(c.mobile), o = digits(c.office);
        body.appendChild(contactRow(name, c.contact || null, m || o, m, m || o));
        // secondary contacts for the same crew
        (Array.isArray(c.more) ? c.more : []).forEach(function (x) {
          var m2 = digits(x.mobile), o2 = digits(x.office);
          body.appendChild(contactRow(name, x.contact || null, m2 || o2, m2, m2 || o2));
        });
      });
    }

    // haulers and drivers assigned to this PO's trucks (Fleet Schedule, or tickets once processed)
    [['Hauler', haulerNames, state.data.haulers], ['Driver', driverNames, state.data.drivers]].forEach(function (g) {
      if (!g[1].length) return;
      body.appendChild(el('div', 'sec-title', g[1].length > 1 ? g[0] + 's' : g[0]));
      g[1].forEach(function (x) {
        var c = (g[2] && g[2][x.name]) || {};
        var m = digits(c.mobile), o = digits(c.office);
        var sub = (c.contact ? c.contact + ' · ' : '') + x.count + (x.count === 1 ? ' truck' : ' trucks');
        body.appendChild(contactRow(x.name, sub, m || o, m, m || o));
      });
    });
    if (loads.length) {
      body.appendChild(el('div', 'sec-title', loads[0].src === 'lht' ? 'Trucks (tickets)' : 'Trucks (scheduled)'));
      loads.forEach(function (t) {
        var line = el('div', 'truckline');
        var head = (t.n ? '#' + t.n + (t.of ? ' of ' + t.of : '') : 'Truck') +
          (t.driver ? ' · ' + t.driver : '') + (t.hauler && t.hauler !== t.driver ? ' · ' + t.hauler : '');
        line.appendChild(el('div', null, head));
        var bits = [];
        if (t.leaveLabel) bits.push((t.src === 'lht' ? 'Sched ' : 'Leave ') + t.leaveLabel);
        if (t.received) bits.push('Recv ' + t.received);
        if (t.trailer) bits.push('Trailer ' + t.trailer);
        if (t.heads) bits.push(fmtNum(t.heads) + ' head');
        if (bits.length) line.appendChild(el('small', null, bits.join(' · ')));
        body.appendChild(line);
      });
    }
    return body;
  }

  // the grower's farm address (added 2026-11-24); Map opens driving directions in the phone's maps
  // app: Apple Maps on an iPhone, Google Maps elsewhere. Only for a complete address.
  function addressRow(addr, ok) {
    var r = el('div', 'contact addr');
    var who = el('div', 'who');
    who.appendChild(document.createTextNode(addr || 'No address on file'));
    if (addr && !ok) who.appendChild(el('small', null, 'Incomplete address in Power Apps'));
    r.appendChild(who);
    if (addr && ok) {
      var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      var a = el('a', 'btn map', 'Map');
      a.href = ios ? 'https://maps.apple.com/?daddr=' + encodeURIComponent(addr)
        : 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addr);
      a.target = '_blank';
      a.rel = 'noopener';
      a.setAttribute('aria-label', 'Directions to ' + addr);
      var b = el('div', 'btns');
      b.appendChild(a);
      r.appendChild(b);
    }
    return r;
  }

  function contactRow(name, title, callNum, textNum, shown, email) {
    var r = el('div', 'contact');
    var who = el('div', 'who');
    who.appendChild(document.createTextNode(dash(name)));
    if (title) who.appendChild(el('small', null, title));
    if (shown) who.appendChild(el('small', 'phone', fmtPhone(shown)));
    if (!callNum && email) who.appendChild(el('small', null, 'No phone on file'));
    r.appendChild(who);
    if (!callNum && !email) {
      r.appendChild(el('span', 'none', 'No phone on file'));
      return r;
    }
    var b = el('div', 'btns');
    if (callNum) {
      var call = el('a', 'btn', 'Call');
      call.href = 'tel:+1' + callNum;
      b.appendChild(call);
    }
    if (textNum) {
      var t = el('a', 'btn text', 'Text');
      t.href = 'sms:+1' + textNum;
      b.appendChild(t);
    }
    if (email) {
      var e = el('a', 'btn mail', 'Email');
      e.href = 'mailto:' + email;
      b.appendChild(e);
    }
    r.appendChild(b);
    return r;
  }

  // ---------- tarping (v11) ----------
  // A section of this same app for the access slots in data.tarping.slots (Terry, Amber): per PO, per truck, the
  // recommended tarp setup from the weather engine, overrides, a "Text crew boss" link, and a decision log that
  // "Send log" mails to the back office. Nothing is sent by the app itself: sms: and mailto: links open the
  // phone's own apps. Format of the log: tarping_log.js. Data without data.tarping shows nothing at all.
  var TARP_DRAFTS = 'ttls.tarp';
  var tarp = { log: null, logTo: null, drafts: null, plan: null, panel: null, open: {}, pruned: false, idx: null, idxFor: null, timer: null };

  function isLocalHost() { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); }
  function tarpSlot() {
    var s = null, a = getAccess();
    if (a) s = a.slot;
    if (isLocalHost()) { // test override, this PC only
      var q = /[?&]slot=([A-Za-z0-9]{2})(?:&|$)/.exec(location.search);
      if (q) s = q[1];
    }
    return s ? String(s).toUpperCase() : null;
  }
  function tarpActive() {
    var T = state.data && state.data.tarping, s = tarpSlot();
    return !!(T && s && window.TarpingLog && Array.isArray(T.slots) && T.slots.indexOf(s) !== -1 && T.rules && T.trucks);
  }
  function tarpStore() { try { return window.localStorage; } catch (e) { return null; } }
  // Which app Send log opens, per phone (v14, Curt 2026-11-25): 'outlook' = the Outlook app (ms-outlook://compose),
  // 'mail' = the phone's default mail app (mailto:). Outlook sends from the company account; the pickup flow only
  // takes Send-log mail from company addresses, and an iPhone's Mail app often holds a personal one.
  // v15 (Curt 2026-11-25): Outlook is the default; after an Outlook open the panel offers "Use Mail app" for the same
  // mail (a page cannot tell whether Outlook is installed). Only the ⋯ menu changes the stored choice.
  var TARP_MAILAPP = 'ttls.tarp.mailapp';
  function tarpMailApp() {
    var v = null;
    try { v = localStorage.getItem(TARP_MAILAPP); } catch (e) { v = null; }
    return v === 'mail' ? 'mail' : 'outlook';
  }
  function setTarpMailApp(v) {
    try { localStorage.setItem(TARP_MAILAPP, v === 'outlook' ? 'outlook' : 'mail'); } catch (e) { /* private mode: default mail app */ }
  }
  function tlog() {
    var T = state.data.tarping;
    if (!tarp.log || tarp.logTo !== T.mailTo) {
      // senders come from tarping\config.json via the build (Curt 2026-11-24: Curt McNiff too); module default otherwise
      tarp.log = TarpingLog.createLog(tarpStore(), { to: T.mailTo || undefined, senders: Array.isArray(T.senders) && T.senders.length ? T.senders : undefined });
      tarp.logTo = T.mailTo;
    }
    return tarp.log;
  }
  function tarpTrucks(po) {
    var T = state.data.tarping;
    if (tarp.idxFor !== T) {
      tarp.idxFor = T; tarp.idx = {};
      Object.keys(T.trucks).forEach(function (k) {
        var t = T.trucks[k];
        if (t && t.po) (tarp.idx[t.po] = tarp.idx[t.po] || []).push(t);
      });
      Object.keys(tarp.idx).forEach(function (p) { tarp.idx[p].sort(function (a, b) { return a.truck - b.truck; }); });
    }
    return tarp.idx[po.id] || [];
  }

  // per-truck work in progress (overrides, reason, top-row choice, crew text stamp, last confirm), kept on the phone
  function allDrafts() {
    if (!tarp.drafts) {
      var o = null;
      try { o = JSON.parse(localStorage.getItem(TARP_DRAFTS) || 'null'); } catch (e) { o = null; }
      tarp.drafts = o && typeof o === 'object' ? o : {};
      var cut = Date.now() - 10 * 86400000;
      Object.keys(tarp.drafts).forEach(function (k) { if (!(tarp.drafts[k] && tarp.drafts[k].at > cut)) delete tarp.drafts[k]; });
    }
    return tarp.drafts;
  }
  function saveDrafts() {
    try { localStorage.setItem(TARP_DRAFTS, JSON.stringify(tarp.drafts || {})); } catch (e) { /* private mode */ }
  }
  function copyPos(p) { return JSON.parse(JSON.stringify(p || {})); }
  // a new forecast for the truck (layout, kind or run time changed) drops the old work in progress
  function draftFor(t) {
    var key = t.po + '|' + t.truck, base = [t.layout, t.kind, t.runAt].join('|'), all = allDrafts(), d = all[key];
    if (!d || d.base !== base) {
      d = all[key] = { base: base, at: Date.now(), pos: copyPos(TarpingLog.parseLayout(t.layout || '-').positions), reason: '', top: null, crewSent: '', conf: null };
    }
    return d;
  }
  function totals(pos) {
    var h = 0, l = 0;
    TarpingLog.POSITIONS.forEach(function (p) { if (pos[p]) { h += pos[p].H || 0; l += pos[p].L || 0; } });
    return { H: h, L: l };
  }
  function topInfo(t) {
    var tr = t.topRow;
    if (!tr) return null;
    var cannot = /cannot be emptied/i.test(tr.line || '');
    return { tr: tr, cannot: cannot, has: !cannot, flagged: !!tr.flagged };
  }
  function topUse(t, d) {
    var i = topInfo(t);
    return !!(i && i.has && (d.top === null || d.top === undefined ? !i.flagged : d.top));
  }
  function nowHm() { return TarpingLog.isoMin(new Date()).slice(11); }
  function clock12(hhmm) {
    var h = +String(hhmm).slice(0, 2), m = String(hhmm).slice(3, 5);
    return ((h + 11) % 12 + 1) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function fcLabel(t) {
    var r = String(t.runAt || '');
    return (t.kind || 'Forecast') + (r.length >= 16 ? ' · ' + fmtDay(r.slice(0, 10)) + ' ' + clock12(r.slice(11, 16)) : '');
  }
  var POINT_NAME = { farm: 'farm', plant: 'plant', mid: 'midpoint' };
  var POS_LABEL = { D: 'Driver side', P: 'Passenger side', T: 'Top', F: 'Front (nose)', R: 'Rear' };

  // plan view, nose at the top, driver side on the left
  var SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function trailerSvg(pos) {
    var s = sv('svg', { viewBox: '0 -30 96 200', width: '78', height: '162', role: 'img', 'class': 'tdiag', 'aria-label': 'Truck from above: cab at the top, trailer below it, driver side on the left' });
    // the truck cab ahead of the nose (Curt 2026-11-24: shows which end is the front), see-through
    var cab = sv('g', { 'class': 'tp-cab' });
    cab.appendChild(sv('rect', { x: 30, y: -27, width: 36, height: 24, rx: 6 }));          // cab roof
    cab.appendChild(sv('path', { d: 'M33 -22 Q48 -29 63 -22', 'class': 'tp-cab-glass' }));  // windshield
    cab.appendChild(sv('rect', { x: 25, y: -21, width: 4, height: 6, rx: 1 }));            // mirrors
    cab.appendChild(sv('rect', { x: 67, y: -21, width: 4, height: 6, rx: 1 }));
    cab.appendChild(sv('line', { x1: 48, y1: -3, x2: 48, y2: 2 }));                        // hitch
    s.appendChild(cab);
    s.appendChild(sv('rect', { x: 24, y: 16, width: 48, height: 138, rx: 3, 'class': 'tp-body' }));
    function lab(k) {
      var c = pos[k] || {}, a = [];
      if (c.H) a.push(c.H + 'H');
      if (c.L) a.push(c.L + 'L');
      return a.join('+');
    }
    function cell(k, x, y, w, h) {
      var c = pos[k] || {};
      s.appendChild(sv('rect', { x: x, y: y, width: w, height: h, rx: 2, 'class': 'tp ' + (c.H ? 't-h' : c.L ? 't-l' : 't-n') }));
    }
    function txt(k, x, y, size, rot) {
      var l = lab(k);
      if (!l) return;
      var a = { x: x, y: y, 'font-size': size, 'class': 'tp-lab ' + ((pos[k] || {}).H ? 'h' : 'l') };
      if (rot) a.transform = 'rotate(' + rot + ' ' + x + ' ' + (y - 3) + ')';
      s.appendChild(sv('text', a, l));
    }
    cell('T', 28, 20, 40, 130); cell('D', 10, 18, 11, 134); cell('P', 75, 18, 11, 134); cell('F', 24, 3, 48, 10); cell('R', 24, 157, 48, 10);
    txt('T', 48, 89, 11); txt('D', 15.5, 89, 9, -90); txt('P', 80.5, 89, 9, 90); txt('F', 48, 11, 8); txt('R', 48, 165, 8);
    return s;
  }

  // ---------- the crew-boss text ----------
  function fillT(tpl, map) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) { return map[k] === undefined ? m : map[k]; });
  }
  function setupText(pos, lang) {
    var S = state.data.tarping.rules.sms, out = [];
    TarpingLog.POSITIONS.forEach(function (k) {
      var c = pos[k];
      if (!c || !(c.H || c.L)) return;
      var name = ((S.positions || {})[TarpingLog.POSITION_NAMES[k]] || {})[lang] || TarpingLog.POSITION_NAMES[k];
      [['H', c.H, S.heavy], ['L', c.L, S.light]].forEach(function (x) {
        if (!x[1]) return;
        // words, not H / L (Curt 2026-11-25: "show light or heavy for planning")
        var w = lang === 'en' ? (x[0] === 'H' ? 'heavy' : 'light') : (x[1] > 1 ? x[2].esPlural || x[2].es : x[2].es);
        out.push(x[1] + ' ' + w + ' ' + name);
      });
    });
    return out.length ? out.join(' / ') : S.none[lang];
  }
  // Spanish weekday for the Spanish block ("lun 11/23"), English fmtDay for the English one
  var DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  function dayEs(ymd) {
    var s = String(ymd || ''); if (s.length < 10) return s;
    var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    return DIAS[d.getUTCDay()] + ' ' + (+s.slice(5, 7)) + '/' + (+s.slice(8, 10));
  }
  // ---- crew wording (Curt 2026-11-25): tarps named by their COLOR at the PO's plant, loads grouped,
  // in the words the crews already get from Terry: "Double yellow or grey tarp 3 & 4th load.
  // Triple yellow or grey tarp 5 & 6th load. 8 per coop leave top empty." Loads with no tarp are not listed.
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  // the plant's tarp colors, null for a plant without a color list (then only "light" / "heavy" is said)
  function crewColors(po, lang) {
    var C = state.data.tarping.rules.sms.colors || {}, c = C[po.plant] || {};
    return { L: (c.light || {})[lang] || null, H: (c.heavy || {})[lang] || null };
  }
  // one truck's tarps in crew words, null when the truck gets no tarp
  function crewSetup(pos, po, lang) {
    var W = state.data.tarping.rules.sms.crew[lang], col = crewColors(po, lang);
    var g = function (k) { var c = pos[k] || {}; return { H: c.H || 0, L: c.L || 0 }; };
    var D = g('D'), P = g('P'), T = g('T'), F = g('F'), R = g('R');
    var nH = D.H + P.H + T.H + F.H + R.H, nL = D.L + P.L + T.L + F.L + R.L;
    if (!nH && !nL) return null;
    // "double light tarp (yellow or grey)" / "doble lona ligera (amarilla o gris)" - type AND colors (Curt 2026-11-25)
    var noun = function (type, count) {
      var c = count === 2 ? W.double + ' ' : count === 3 ? W.triple + ' ' : '';
      var colors = col[type] ? ' (' + col[type] + ')' : '';
      return c + (lang === 'es' ? W.tarp + ' ' + W[type] : W[type] + ' ' + W.tarp) + colors;
    };
    // the crews' shorthand when all tarps are one type: Double = one each side, Triple = each side + one on top
    var one = nH && !nL ? 'H' : !nH && nL ? 'L' : null;
    if (one && !F[one] && !R[one] && D[one] === 1 && P[one] === 1 && T[one] <= 1) return cap1(noun(one, T[one] ? 3 : 2));
    // anything else: position by position, joined with " + "
    var parts = [];
    if (D.H === 1 && P.H === 1 && !D.L && !P.L) { parts.push(noun('H', 0) + ' ' + W.bothSides); D = { H: 0, L: 0 }; P = { H: 0, L: 0 }; }
    else if (D.L === 1 && P.L === 1 && !D.H && !P.H) { parts.push(noun('L', 0) + ' ' + W.bothSides); D = { H: 0, L: 0 }; P = { H: 0, L: 0 }; }
    [['D', D], ['P', P], ['T', T], ['F', F], ['R', R]].forEach(function (x) {
      if (x[1].H) parts.push(noun('H', x[1].H) + ' ' + W.pos[x[0]]);
      if (x[1].L) parts.push(noun('L', x[1].L) + ' ' + W.pos[x[0]]);
    });
    return cap1(parts.join(' + '));
  }
  // truck numbers -> "3 & 4th load" / "last 2" / "all loads" ("cargas 3 y 4" / "últimas 2" / "todas las cargas")
  function crewLoads(nums, total, lang) {
    var W = state.data.tarping.rules.sms.crew[lang];
    nums = nums.slice().sort(function (a, b) { return a - b; });
    if (total && nums.length === total) return W.allLoads;
    var run = nums.every(function (n, i) { return i === 0 || n === nums[i - 1] + 1; });
    if (total && run && nums[nums.length - 1] === total) return nums.length === 1 ? W.lastOne : fillT(W.lastN, { n: nums.length });
    if (lang === 'es') return (nums.length === 1 ? W.load + ' ' + nums[0] : W.loads + ' ' + nums.slice(0, -1).join(', ') + ' ' + W.and + ' ' + nums[nums.length - 1]);
    var last = nums[nums.length - 1], sfx = (last % 100 >= 11 && last % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[last % 10] || 'th');
    return (nums.length === 1 ? '' : nums.slice(0, -1).join(', ') + ' ' + W.and + ' ') + last + sfx + ' ' + W.load;
  }
  // the farm's state from the GROWER CARD address (po.address: 7.0 ALL POs grower columns, Active Growers fallback),
  // e.g. "692 HENDRICKS LANE, SCOTTSVILLE, KY 42164"; the forecast's farm location only when the card has none
  function farmState(po, list) {
    var m = /,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(String(po.address || '').trim());
    if (m) return m[1];
    var f = (list[0].t.points || []).filter(function (p) { return p.name === 'farm'; })[0];
    m = f && /,\s*([A-Z]{2})\b/.exec(f.label || '');
    return m ? m[1] : '';
  }
  // list = [{ t, d }] for the PO's trucks that have a recommendation
  function smsBody(po, list) {
    var S = state.data.tarping.rules.sms;
    var total = +(list[0].t.of || po.trucks || 0) || list.length;
    function block(lang) {
      var W = S.crew[lang], f = list[0].t, cd = f.catch || po.catch;
      var lines = [fillT((S.crewHeader || S.header)[lang], { grower: po.grower || '', state: farmState(po, list), po: po.id, 'catch': lang === 'es' ? dayEs(cd) : fmtDay(cd) }).replace(/,\s*(?=\s-\s)/, '').replace(/\s+-\s*$/, '').replace(/\s{2,}/g, ' ')];
      // trucks with the same tarps and the same top-row line share one line, in truck order
      var groups = [], byKey = {};
      list.slice().sort(function (a, b) { return a.t.truck - b.t.truck; }).forEach(function (x) {
        var s = crewSetup(x.d.pos, po, lang), top = topUse(x.t, x.d) ? x.t.topRow.required : null;
        if (!s && !top) return;
        var key = (s || '-') + '|' + (top || '');
        if (!byKey[key]) { byKey[key] = { s: s, top: top, nums: [] }; groups.push(byKey[key]); }
        byKey[key].nums.push(x.t.truck);
      });
      if (!groups.length) lines.push(W.noTarp);
      groups.forEach(function (gr) {
        var s = gr.s || W.noTarpShort;
        var line = s + (s.indexOf(' + ') >= 0 ? ', ' : ' ') + crewLoads(gr.nums, total, lang) + '.';
        if (gr.top) line += ' ' + fillT(W.topRow, { n: gr.top });
        lines.push(line);
      });
      // a blank line below the header and between the load groups (Curt 2026-11-25); no footer
      return lines.join('\n\n');
    }
    // a row of dashes between the English and the Spanish (Curt 2026-11-25)
    return S.spanish === false ? block('en') : block('en') + '\n\n---------------\n\n' + block('es');
  }

  // ---------- the section inside a PO ----------
  function buildTarping(po) {
    var trucks = tarpTrucks(po);
    if (!trucks.length) return null;
    var T = state.data.tarping, rules = T.rules;
    var sec = el('div', 'tarp');
    // collapsed by default (Curt 2026-11-24): one tap on the header opens the truck cards; the choice is kept
    // for this PO until the app is closed
    tarp.openPo = tarp.openPo || {};
    var open = !!tarp.openPo[po.id];
    var head = el('button', 'tarp-head');
    head.type = 'button';
    var inner = el('div', 'tarp-body');
    function paintHead() {
      var n = trucks.length, conf = trucks.filter(function (t) { return !!draftFor(t).conf; }).length;
      var colds = trucks.map(function (t) { return t.coldF; }).filter(function (v) { return v != null; });
      var bits = [n + (n === 1 ? ' truck' : ' trucks')];
      if (colds.length) bits.push('coldest ' + Math.min.apply(null, colds) + '°F');
      bits.push(conf + ' of ' + n + ' confirmed');
      head.textContent = '';
      head.appendChild(el('span', 'tarp-head-t', 'Tarping'));
      head.appendChild(el('span', 'tarp-head-s', bits.join(' · ')));
      head.appendChild(el('span', 'tarp-chev', open ? '▾' : '▸'));
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      inner.hidden = !open;
    }
    head.addEventListener('click', function () { open = !open; tarp.openPo[po.id] = open; paintHead(); });
    sec.appendChild(head);
    sec.appendChild(inner);
    var cards = [], textHost = el('div', 'ttext');

    function paintText() {
      paintHead();
      textHost.textContent = '';
      var list = trucks.filter(function (t) { return t.rec && t.layout; }).map(function (t) { return { t: t, d: draftFor(t) }; });
      var seen = {}, names = (po.crew || []).filter(function (n) { if (seen[n]) return false; seen[n] = true; return true; });
      var none = function (who) {
        var r = el('div', 'contact');
        r.appendChild(el('div', 'who', who || 'Crew boss'));
        var b = el('button', 'btn tarp-text off', 'No crew boss phone on file');
        b.type = 'button'; b.disabled = true;
        r.appendChild(b);
        return r;
      };
      if (!names.length) { textHost.appendChild(none('')); return; }
      names.forEach(function (name) {
        var c = (state.data.catchers && state.data.catchers[name]) || {}, m = digits(c.mobile);
        if (!m) { textHost.appendChild(none(name)); return; }
        if (!list.length) {
          var r0 = el('div', 'contact');
          r0.appendChild(el('div', 'who', name));
          var b0 = el('button', 'btn tarp-text off', 'No setup to text');
          b0.type = 'button'; b0.disabled = true;
          r0.appendChild(b0);
          textHost.appendChild(r0);
          return;
        }
        var r = el('div', 'contact');
        var who = el('div', 'who');
        who.appendChild(document.createTextNode(name));
        var sent = list.filter(function (x) { return x.d.crewSent; }).map(function (x) { return x.d.crewSent; }).sort().pop();
        if (sent) who.appendChild(el('small', null, 'Text opened ' + sent.slice(11)));
        r.appendChild(who);
        var a = el('a', 'btn text tarp-text', names.length > 1 ? 'Text ' + name : 'Text crew boss');
        a.href = 'sms:+1' + m + '?body=' + encodeURIComponent(smsBody(po, list));
        a.addEventListener('click', function () {
          // the phone's own messages app opens with the text; here only the time is noted
          var stamp = TarpingLog.isoMin(new Date()), ids = [];
          list.forEach(function (x) { x.d.crewSent = stamp; if (x.d.conf) ids.push(x.d.conf.id); });
          saveDrafts();
          if (ids.length) tlog().setCrewSent(ids, stamp);
          setTimeout(paintText, 600);
        });
        r.appendChild(a);
        textHost.appendChild(r);
      });
    }

    trucks.forEach(function (t) { cards.push(buildTruck(po, t, paintText)); });
    cards.forEach(function (c) { inner.appendChild(c); });
    inner.appendChild(el('div', 'sec-title', 'Crew boss'));
    inner.appendChild(textHost);
    paintText();
    return sec;
  }

  function buildTruck(po, t, onChange) {
    var T = state.data.tarping, rules = T.rules, inv = rules.inventory || { L: 3, H: 2 }, carried = rules.carried || { L: 3, H: 3 };
    var key = t.po + '|' + t.truck, card = el('div', 'tcard'), msg = '';
    card.setAttribute('data-truck', key);

    function paint() {
      card.textContent = '';
      var d = draftFor(t), fin = TarpingLog.formatLayout(d.pos), tot = totals(d.pos);
      var head = el('div', 't-head');
      head.appendChild(el('b', null, 'Truck ' + t.truck + (t.of ? ' of ' + t.of : '')));
      head.appendChild(el('span', 't-fc ' + (t.kind === 'Final' ? 'final' : 'prev'), fcLabel(t)));
      card.appendChild(head);

      if (!t.rec || !t.layout) {
        card.appendChild(el('div', 't-none', 'No weather for this truck' + ((t.problems || []).length ? ' (' + t.problems.join('; ') + ')' : '') + '. Set its tarps in Power Apps.'));
        return;
      }

      var row = el('div', 't-row');
      row.appendChild(trailerSvg(d.pos));
      var info = el('div', 't-info');
      info.appendChild(el('div', 't-setup', TarpingLog.formatLayout(d.pos) === '-' ? 'No tarps' : setupText(d.pos, 'en')));
      if (fin !== t.layout) info.appendChild(el('div', 't-was', 'Recommended: ' + (t.text || t.layout)));
      var cold = 'Coldest ' + t.coldF + '°F';
      if (t.coldAt) cold += ' · ' + (POINT_NAME[t.coldAt.point] || t.coldAt.point) + ' · ' + clock12(String(t.coldAt.hour).slice(11, 16));
      info.appendChild(el('div', 't-cold', cold));
      var tags = el('div', 'badges');
      tags.appendChild(el('span', 'badge ' + (t.rain ? 'rainb' : ''), t.rain ? 'Rain' + (t.rainPct != null ? ' ' + t.rainPct + '%' : '') : 'Dry'));
      if (t.category) tags.appendChild(el('span', 'badge', t.category));
      if (t.warmDrop) tags.appendChild(el('span', 'badge pattern', 'Warming: no top light'));
      info.appendChild(tags);
      if (t.note) info.appendChild(el('div', 't-note', t.note));
      row.appendChild(info);
      card.appendChild(row);
      // temperature at each weather point in the truck window: farm, midpoint (long haul), plant (Curt 2026-11-24)
      var pts = (Array.isArray(t.points) ? t.points : []).filter(function (p) { return p && p.lowF != null; });
      if (pts.length) {
        var order = { farm: 0, mid: 1, plant: 2 };
        pts.sort(function (a, b) { return (order[a.name] == null ? 9 : order[a.name]) - (order[b.name] == null ? 9 : order[b.name]); });
        var tbl = el('div', 't-points');
        pts.forEach(function (p) {
          var isCold = t.coldAt && t.coldAt.point === p.name && t.coldF === p.lowF;
          var pr = el('div', 't-pt' + (isCold ? ' cold' : ''));
          var nm = { farm: 'Farm', mid: 'Midpoint', plant: 'Plant' }[p.name] || p.name;
          var lbl = p.name === 'mid' || /^midpoint/i.test(p.label || '') ? '' : (p.label || '');
          pr.appendChild(el('span', 't-pt-name', nm + (lbl ? ' · ' + lbl : '')));
          pr.appendChild(el('span', 't-pt-temp', p.lowF + '°F' + (p.highF != null && p.highF !== p.lowF ? '–' + p.highF + '°F' : '')));
          pr.appendChild(el('span', 't-pt-hour', 'low ' + clock12(String(p.lowAt || '').slice(11, 16))));
          pr.appendChild(el('span', 't-pt-rain' + (p.rainPct >= (rules.rainProbPct || 45) ? ' wet' : ''), 'rain ' + (p.rainPct == null ? '-' : p.rainPct + '%')));
          tbl.appendChild(pr);
        });
        card.appendChild(tbl);
      }

      // top row of coops
      var ti = topInfo(t);
      if (ti) {
        var tb = el('div', 't-top' + (ti.flagged ? ' flag' : ''));
        tb.appendChild(el('div', null, ti.tr.line));
        if (ti.has) {
          var use = topUse(t, d), btns = el('div', 'tbtns');
          [['Use', true], ['Don\'t use', false]].forEach(function (o) {
            var b = el('button', 'tbtn' + (use === o[1] ? ' on' : ''), o[0]);
            b.type = 'button';
            b.setAttribute('aria-pressed', String(use === o[1]));
            b.setAttribute('data-top', o[1] ? 'use' : 'skip');
            b.addEventListener('click', function () { d.top = o[1]; saveDrafts(); paint(); onChange(); });
            btns.appendChild(b);
          });
          tb.appendChild(btns);
        }
        card.appendChild(tb);
      }

      // overrides
      var det = el('details', 't-ovr');
      if (tarp.open[key]) det.open = true;
      det.addEventListener('toggle', function () { tarp.open[key] = det.open; });
      det.appendChild(el('summary', null, 'Change tarps'));
      var grid = el('div', 't-grid');
      grid.appendChild(el('span')); grid.appendChild(el('span', 'gh', 'Light')); grid.appendChild(el('span', 'gh', 'Heavy'));
      TarpingLog.POSITIONS.forEach(function (p) {
        grid.appendChild(el('span', 'gl', POS_LABEL[p]));
        ['L', 'H'].forEach(function (kind) {
          var sel = el('select');
          sel.setAttribute('aria-label', POS_LABEL[p] + (kind === 'L' ? ' light' : ' heavy'));
          sel.setAttribute('data-pos', p + kind);
          for (var i = 0; i <= 3; i++) { var o = el('option', null, String(i)); o.value = String(i); sel.appendChild(o); }
          sel.value = String((d.pos[p] || {})[kind] || 0);
          sel.addEventListener('change', function () {
            var prev = (d.pos[p] || {})[kind] || 0, v = +sel.value;
            var c = d.pos[p] || { H: 0, L: 0 };
            var next = { H: c.H || 0, L: c.L || 0 };
            next[kind] = v;
            d.pos[p] = next;
            var tt = totals(d.pos);
            if (tt.H > carried.H || tt.L > carried.L) {
              next[kind] = prev;
              msg = 'The trailer carries only ' + carried.H + ' heavy and ' + carried.L + ' light tarps.';
            } else msg = '';
            if (!(d.pos[p].H || d.pos[p].L)) delete d.pos[p];
            saveDrafts(); paint(); onChange();
          });
          grid.appendChild(sel);
        });
      });
      det.appendChild(grid);
      det.appendChild(el('div', 't-tot', 'Trailer total: ' + tot.H + ' heavy, ' + tot.L + ' light (carries ' + carried.H + ' heavy, ' + carried.L + ' light)'));
      var third = tot.H > inv.H;
      if (third) det.appendChild(el('div', 't-warn', 'A 3rd heavy is your call. Say why below.'));
      var rl = el('label', 't-reason');
      rl.appendChild(document.createTextNode(third ? 'Reason (needed for a 3rd heavy)' : 'Reason (optional)'));
      var ri = el('input');
      ri.type = 'text'; ri.maxLength = TarpingLog.REASON_MAX; ri.value = d.reason || ''; ri.setAttribute('data-reason', '1');
      ri.setAttribute('autocomplete', 'off');
      ri.addEventListener('input', function () { d.reason = ri.value; saveDrafts(); });
      rl.appendChild(ri);
      det.appendChild(rl);
      card.appendChild(det);
      if (msg) card.appendChild(el('div', 't-warn', msg));

      // confirm
      var use2 = topUse(t, d), cf = d.conf;
      var same = !!cf && cf.fin === fin && cf.top === use2 && cf.reason === (d.reason || '').trim().slice(0, TarpingLog.REASON_MAX);
      var st = el('div', 't-state');
      if (cf) st.appendChild(el('span', 't-ok', '✓ Logged ' + cf.at + ' · ' + (cf.fin === '-' ? 'no tarps' : cf.fin) + (same ? '' : ' (changed since)')));
      card.appendChild(st);
      var cb = el('button', 'tconf', cf ? (same ? 'Confirmed' : 'Confirm again') : 'Confirm');
      cb.type = 'button';
      cb.disabled = same;
      cb.addEventListener('click', function () {
        var need = totals(d.pos).H > inv.H && !(d.reason || '').trim();
        if (need) { msg = 'A 3rd heavy needs a reason.'; tarp.open[key] = true; paint(); return; }
        ensureSender(function () {
          var tr = t.topRow, ti2 = topInfo(t), use3 = topUse(t, d);
          try {
            var e = tlog().addEntry({
              po: t.po, kill: t.kill, 'catch': t.catch, truck: t.truck, rec: t.layout, fin: TarpingLog.formatLayout(d.pos), reason: d.reason,
              topRec: ti2 && ti2.has ? 'Y' : 'N', topFin: use3 ? 'Y' : 'N',
              perCoop: tr ? (use3 ? tr.required : tr.planned) : '',
              coldF: t.coldF, loc: t.coldAt ? t.coldAt.point : '', hour: t.coldAt ? String(t.coldAt.hour).slice(11, 16) : '',
              rain: t.rain ? 'Y' : 'N', fc: t.kind === 'Final' ? 'F' : 'P', crewSent: d.crewSent || '',
              fsWas: t.fsWas ? (t.fsWas.heavy || 0) + 'H' + (t.fsWas.light || 0) + 'L' : '-',
              dataAt: String(state.data.builtAt || '').slice(0, 16)
            }, new Date());
            d.conf = { id: e.id, at: nowHm(), fin: e.f.fin, top: use3, reason: e.f.reason };
            msg = '';
            saveDrafts();
          } catch (err) { msg = 'Could not log this decision: ' + err.message; }
          paint(); onChange(); tarpBarRefresh();
        });
      });
      card.appendChild(cb);
    }
    paint();
    return card;
  }

  // ---------- Send log ----------
  function openMail(url) {
    var a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  function ensureSender(next) {
    var L = tlog();
    if (L.getSender()) { next(); return; }
    tarp.panel = { kind: 'sender', next: next };
    tarpBarRefresh();
    var p = $('tarppanel');
    if (p && p.scrollIntoView) p.scrollIntoView({ block: 'center' });
  }
  function startBatch(batch) {
    if (!batch.parts.length) { tarp.panel = { kind: 'info', text: 'Nothing to send.' }; tarpBarRefresh(); return; }
    tarp.plan = { batch: batch, next: 0 };
    nextPart();
  }
  function nextPart() {
    var pl = tarp.plan, p = pl.batch.parts[pl.next], ol = tarpMailApp() === 'outlook' && p.outlook;
    pl.next++;
    tlog().markSent(p.ids, pl.batch.batchId, new Date());   // opened in the mail app; "Resend last 7 days" covers a lost mail
    tarp.panel = pl.next < pl.batch.parts.length
      ? { kind: 'part', k: pl.next, m: pl.batch.parts.length, fallback: ol ? p : null }
      : { kind: 'info', fallback: ol ? p : null, text: ol
        ? 'Outlook opened with ' + pl.batch.n + (pl.batch.n === 1 ? ' entry' : ' entries') + '. Press send in Outlook.'
        : 'Mail opened with ' + pl.batch.n + (pl.batch.n === 1 ? ' entry' : ' entries') + '. Press send in your mail app.' };
    tarpBarRefresh();
    openMail(ol ? p.outlook : p.mailto);
  }
  // ---------- delete log entries (Curt 2026-11-25: "ask twice before deleting") ----------
  // From the ⋯ menu: the entries kept on this phone, newest first, one Delete each plus Delete all. Every delete asks
  // two questions; the second says how many of them were never emailed. Deleting touches this phone only.
  function logSetup(e) {
    var p = TarpingLog.parseLayout(e.f.fin || '-');
    return p.ok ? setupText(p.positions, 'en') : String(e.f.fin || '');
  }
  function loggedAt(e) {
    var s = TarpingLog.isoMin(new Date(e.ts));
    return fmtDay(s.slice(0, 10)) + ' ' + clock12(s.slice(11));
  }
  // a truck whose logged decision was deleted falls back to its newest remaining entry, or to Confirm when none is left
  function tarpDelete(ids) {
    var L = tlog(), c = L.removeEntries(ids), left = L.entries(), all = allDrafts(), changed = false;
    Object.keys(all).forEach(function (k) {
      var d = all[k];
      if (!d || !d.conf || ids.indexOf(d.conf.id) === -1) return;
      var key = k.split('|'), prev = null;
      left.forEach(function (e) { if (e.f.po === key[0] && String(e.f.truck) === key[1]) prev = e; }); // oldest first: last = newest
      d.conf = prev ? { id: prev.id, at: TarpingLog.isoMin(new Date(prev.ts)).slice(11), fin: prev.f.fin, top: prev.f.topFin === 'Y', reason: prev.f.reason } : null;
      changed = true;
    });
    if (changed) saveDrafts();
    return c;
  }
  function buildDeletePanel(box, pn, L) {
    var list = L.entries().reverse(), unsent = {};
    list.forEach(function (e) { if (!e.sentAt) unsent[e.id] = true; });
    var ask = pn.ask;
    if (ask) {
      var nu = ask.ids.filter(function (id) { return unsent[id]; }).length;
      box.appendChild(el('div', 'tp-q', ask.stage === 1
        ? 'Delete ' + ask.what + '?'
        : 'Are you sure? ' + cap1(ask.what) + ' will be deleted from this phone and cannot be brought back.' +
          (nu ? ' ' + nu + (nu === 1 ? ' entry was' : ' entries were') + ' never emailed and will not reach the office.' : '')));
      var yes = el('button', 'tbtn danger', ask.stage === 1 ? 'Yes, delete' : 'Delete for good');
      yes.type = 'button'; yes.id = ask.stage === 1 ? 'tarp-del-yes1' : 'tarp-del-yes2';
      yes.addEventListener('click', function () {
        if (ask.stage === 1) { ask.stage = 2; tarpBarRefresh(); return; }
        var c = tarpDelete(ask.ids);
        tarp.panel = { kind: 'info', text: 'Deleted ' + c + (c === 1 ? ' log entry' : ' log entries') + ' from this phone.' };
        render(); // truck cards show the change
      });
      var no = el('button', 'tbtn', 'Cancel');
      no.type = 'button'; no.id = 'tarp-del-no';
      no.addEventListener('click', function () { pn.ask = null; tarpBarRefresh(); });
      box.appendChild(yes); box.appendChild(no);
      return;
    }
    if (!list.length) { box.appendChild(el('div', 'tp-q', 'No log entries on this phone.')); return; }
    box.appendChild(el('div', 'tp-q', 'Log entries on this phone (' + list.length + '). Deleting removes them from this phone only; entries already emailed stay in the office log.'));
    list.forEach(function (e) {
      var r = el('div', 'tdel-row'), txt = el('div', 'tdel-t');
      txt.appendChild(el('div', 'tdel-l1', e.f.po + ' · truck ' + e.f.truck + ' · catch ' + fmtDay(e.f['catch'])));
      txt.appendChild(el('div', 'tdel-l2', logSetup(e) + ' · logged ' + loggedAt(e) + (e.sentAt ? ' · emailed' : ' · not emailed yet')));
      var b = el('button', 'tbtn', 'Delete');
      b.type = 'button'; b.setAttribute('data-del', e.id);
      b.addEventListener('click', function () {
        pn.ask = { ids: [e.id], what: 'the entry for ' + e.f.po + ' truck ' + e.f.truck + ' (logged ' + loggedAt(e) + ')', stage: 1 };
        tarpBarRefresh();
      });
      r.appendChild(txt); r.appendChild(b);
      box.appendChild(r);
    });
    var da = el('button', 'tbtn danger', 'Delete all (' + list.length + ')');
    da.type = 'button'; da.id = 'tarp-delall';
    da.addEventListener('click', function () {
      pn.ask = { ids: list.map(function (e) { return e.id; }), what: 'all ' + list.length + ' log ' + (list.length === 1 ? 'entry' : 'entries') + ' on this phone', stage: 1 };
      tarpBarRefresh();
    });
    box.appendChild(da);
  }

  function tarpBarRefresh() {
    var bar = $('tarpbar'), banner = $('tarpbanner');
    if (!bar || !banner) return;
    if (!state.data || !tarpActive()) { bar.hidden = true; banner.hidden = true; return; }
    var L = tlog();
    if (!tarp.pruned) { tarp.pruned = true; L.prune(new Date()); }
    var n = L.unsentCount(), red = L.isRed(new Date());
    bar.hidden = false;
    bar.textContent = '';
    var row = el('div', 'tarprow');
    var send = el('button', 'tsend' + (red ? ' red' : ''), (tarpMailApp() === 'outlook' ? 'Send log in Outlook (' : 'Send log (') + n + ')');
    send.type = 'button'; send.id = 'tarp-send'; send.disabled = n === 0;
    send.addEventListener('click', function () {
      ensureSender(function () { startBatch(tlog().buildBatch(tlog().unsent(), new Date())); });
    });
    var more = el('button', 'tmore', '⋯');
    more.type = 'button'; more.id = 'tarp-menu';
    more.setAttribute('aria-label', 'More log options');
    more.addEventListener('click', function () {
      tarp.panel = tarp.panel && tarp.panel.kind === 'menu' ? null : { kind: 'menu' };
      tarpBarRefresh();
    });
    row.appendChild(send); row.appendChild(more);
    bar.appendChild(row);
    var pn = tarp.panel;
    if (pn) {
      var box = el('div', 'tpanel');
      box.id = 'tarppanel';
      if (pn.kind === 'sender') {
        box.appendChild(el('div', 'tp-q', 'Who is sending the log from this phone? (asked once)'));
        var slot = tarpSlot(), sn = (state.data.tarping && state.data.tarping.slotNames) || { RN: 'Terry Fountain', HE: 'Amber Avery' };
        var pref = sn[slot] || '';
        L.senders.forEach(function (s) {
          var b = el('button', 'tbtn' + (s === pref ? ' on' : ''), s);
          b.type = 'button'; b.setAttribute('data-sender', s);
          b.addEventListener('click', function () { L.setSender(s); var nx = pn.next; tarp.panel = null; tarpBarRefresh(); if (nx) nx(); });
          box.appendChild(b);
        });
      } else if (pn.kind === 'part') {
        box.appendChild(el('div', 'tp-q', 'Part ' + pn.k + ' of ' + pn.m + ' opened. Send it, then open the next.'));
        var nb = el('button', 'tsend', 'Send part ' + (pn.k + 1) + ' of ' + pn.m);
        nb.type = 'button'; nb.id = 'tarp-nextpart';
        nb.addEventListener('click', nextPart);
        box.appendChild(nb);
      } else if (pn.kind === 'menu') {
        var rs = el('button', 'tbtn', 'Resend last 7 days');
        rs.type = 'button'; rs.id = 'tarp-resend';
        rs.addEventListener('click', function () {
          ensureSender(function () { tarp.panel = null; startBatch(tlog().resendBatch(new Date())); });
        });
        box.appendChild(rs);
        var dm = el('button', 'tbtn', 'Delete log entries');
        dm.type = 'button'; dm.id = 'tarp-delmenu';
        dm.addEventListener('click', function () { tarp.panel = { kind: 'delete', ask: null }; tarpBarRefresh(); });
        box.appendChild(dm);
        var app = tarpMailApp();
        box.appendChild(el('div', 'tp-q', 'Send with (this phone):'));
        [['mail', 'Mail app'], ['outlook', 'Outlook']].forEach(function (o) {
          var mb = el('button', 'tbtn' + (app === o[0] ? ' on' : ''), o[1]);
          mb.type = 'button'; mb.setAttribute('data-mailapp', o[0]);
          mb.addEventListener('click', function () { setTarpMailApp(o[0]); tarpBarRefresh(); });
          box.appendChild(mb);
        });
        var who = L.getSender();
        var ch = el('button', 'tbtn', who ? 'Sender: ' + who + ' (change)' : 'Choose sender');
        ch.type = 'button';
        ch.addEventListener('click', function () { tarp.panel = { kind: 'sender', next: null }; tarpBarRefresh(); });
        box.appendChild(ch);
      } else if (pn.kind === 'delete') {
        buildDeletePanel(box, pn, L);
      } else {
        box.appendChild(el('div', 'tp-q', pn.text));
      }
      if (pn.fallback && (pn.kind === 'part' || pn.kind === 'info')) {
        // same mail through the phone's default mail app; the stored choice stays as it is
        var fb = el('button', 'tbtn', 'Outlook did not open? Use Mail app');
        fb.type = 'button'; fb.id = 'tarp-fallback';
        fb.addEventListener('click', function () {
          var fp = pn.fallback;
          pn.fallback = null;
          if (pn.kind === 'info') pn.text = 'Mail app opened. Send it from your company email address (other addresses are not picked up). To use the Mail app every time: ⋯ → Send with: Mail app.';
          tarpBarRefresh();
          openMail(fp.mailto);
        });
        box.appendChild(fb);
      }
      if (pn.kind !== 'part') {
        var x = el('button', 'tbtn quiet', 'Close');
        x.type = 'button';
        x.addEventListener('click', function () { tarp.panel = null; tarpBarRefresh(); });
        box.appendChild(x);
      }
      bar.appendChild(box);
    }
    banner.hidden = !red;
    if (red) banner.textContent = 'Tarping log: ' + n + (n === 1 ? ' decision' : ' decisions') + ' not sent for over 12 hours. Tap Send log.';
    syncSticky();
  }
  function tarpStart() {
    if (tarp.timer) return;
    tarp.timer = setInterval(function () { if (state.data) tarpBarRefresh(); }, 60000);
  }

  // ---------- sticky offsets ----------
  function syncSticky() {
    var h = $('hdr').offsetHeight;
    var root = document.documentElement.style;
    root.setProperty('--hdr-h', h + 'px');
    var tabs = $('tabs');
    root.setProperty('--sticky-h', (h + (tabs.hidden ? 0 : tabs.offsetHeight) + 6) + 'px');
  }

  // ---------- wiring ----------
  $('refresh').addEventListener('click', function () { load(true); swCheck(); });
  $('search').addEventListener('input', function (e) {
    state.query = e.target.value;
    render();
  });
  ['schedule', 'directory'].forEach(function (v) {
    $('v-' + v).addEventListener('click', function () {
      if (state.view === v) return;
      state.view = v;
      render();
      window.scrollTo(0, 0);
    });
  });
  $('dsearch').addEventListener('input', function (e) {
    state.dquery = e.target.value;
    render();
  });
  $('d-company').addEventListener('change', function (e) {
    state.dcompany = e.target.value;
    render();
  });
  state.filters = loadFilters();
  FILTERS.forEach(function (f) {
    $(f.id).addEventListener('change', function (e) {
      state.filters[f.key] = e.target.value;
      saveFilters();
      render();
    });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - state.lastFetch > REFETCH_MS) load(false);
  });
  window.addEventListener('resize', syncSticky);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.data) tarpBarRefresh(); });
  tarpStart();

  // New app versions (v18, Curt 2026-11-25: "the iPhone app didn't update"): an iPhone keeps the app open in the
  // background for days and only looked for a new version on a cold start. Now the ↻ button and every return to the
  // app check for one; when the new version takes over, the page reloads once - right away, or when the app is next
  // put away if a panel is open or a field is being typed in.
  var swReg = null, swReloaded = false, swPending = false;
  function swCheck() { if (swReg && swReg.update) swReg.update().catch(function () {}); }
  function swReload() { if (swReloaded) return; swReloaded = true; location.reload(); }
  if ('serviceWorker' in navigator) {
    var hadSw = !!navigator.serviceWorker.controller; // first visit: the worker takes control, nothing to reload
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadSw) return;
      var a = document.activeElement, typing = !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      if (tarp.panel || typing) swPending = true; else swReload();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && swPending) swReload();
      else if (document.visibilityState === 'visible') swCheck();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').then(function (r) { swReg = r; }).catch(function () {});
    });
  }

  render();
  load(false);
})();
