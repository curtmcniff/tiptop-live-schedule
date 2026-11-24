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
    days.forEach(function (day) { main.appendChild(buildDay(day, byDay[day] || [], day === today)); });
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function buildDay(day, pos, isToday) {
    var sec = el('section', 'day');
    var live = pos.filter(function (p) { return !p.draft; });
    var drafts = pos.length - live.length;
    var head = live.reduce(function (s, p) { return s + (+p.head || 0); }, 0);

    var hdr = el('div', 'day-hdr' + (isToday ? ' today' : ''));
    var left = el('div');
    left.appendChild(el('div', 'day-title', fmtDay(day) + (isToday ? ' (today)' : '')));
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
    var toggle = el('button', 'day-toggle', 'Expand all');
    toggle.type = 'button';
    toggle.addEventListener('click', function () {
      var open = toggle.textContent === 'Expand all';
      rows.forEach(function (r) { r.set(open); });
      toggle.textContent = open ? 'Collapse all' : 'Expand all';
    });
    hdr.appendChild(toggle);
    rows.forEach(function (r) { sec.appendChild(r.node); });
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
    row('Pack', po.pack ? fmtDay(po.pack) + (po.packEst ? ' (est.)' : '') : '—');
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

  // ---------- sticky offsets ----------
  function syncSticky() {
    var h = $('hdr').offsetHeight;
    var root = document.documentElement.style;
    root.setProperty('--hdr-h', h + 'px');
    var tabs = $('tabs');
    root.setProperty('--sticky-h', (h + (tabs.hidden ? 0 : tabs.offsetHeight) + 6) + 'px');
  }

  // ---------- wiring ----------
  $('refresh').addEventListener('click', function () { load(true); });
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

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  render();
  load(false);
})();
