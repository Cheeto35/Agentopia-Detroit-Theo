(() => {
  'use strict';

  const REFRESH_MS = 5000;
  const VIEWS = ['overview', 'citizens', 'places', 'relationships', 'activity', 'engine', 'systems'];

  // Phases of one simulated week, in order (mirrors src/world/clock.py Stage).
  const PHASES = [
    { key: 'begin',          short: 'Start',      text: 'A new week is starting' },
    { key: 'plan',           short: 'Plan',       text: 'Citizens are planning their goals for the week' },
    { key: 'before_contact', short: 'World news', text: 'World events are announced and citizens react to them' },
    { key: 'contact',        short: 'Talk',       text: 'Citizens are reaching out and talking to each other' },
    { key: 'after_contact',  short: 'Arrange',    text: 'Conversations are being turned into plans' },
    { key: 'activity',       short: 'Do',         text: 'Citizens are carrying out their activities' },
    { key: 'review',         short: 'Reflect',    text: 'Citizens are looking back on their week' },
    { key: 'settle',         short: 'Settle',     text: 'Wrapping up the week: income, costs and needs are updated' },
  ];
  const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.key, i]));

  const NEEDS = [
    { key: 'vitality', label: 'Energy',     hint: 'Health and physical energy' },
    { key: 'mood',     label: 'Mood',       hint: 'Day-to-day happiness' },
    { key: 'social',   label: 'Social',     hint: 'Feeling connected to others' },
    { key: 'esteem',   label: 'Self-worth', hint: 'Confidence and respect' },
    { key: 'material', label: 'Comfort',    hint: 'Happiness with their living standard' },
  ];

  const ENGINE_STATES = {
    live:     { label: 'Running',  help: 'The simulation is running and writing new data.' },
    thinking: { label: 'Thinking', help: 'The simulation is running and waiting on the AI model.' },
    waiting:  { label: 'Working',  help: 'The simulation is running a long step and has not written new data for a few minutes.' },
    booting:  { label: 'Starting', help: 'The simulation is starting up.' },
    stopped:  { label: 'Stopped',  help: 'The simulation process is not running.' },
    offline:  { label: 'Offline',  help: 'The dashboard cannot reach its server.' },
  };

  const SYSTEM_MODULES = {
    detroit_history: 'Detroit history', cognition: 'Cognitive society', humanity: 'Human lifecycle',
    mission_power: 'Missions & power', financial_network: 'Financial network', career_economy: 'Career economy',
    human_economy: 'Human economy', business_economy: 'Business economy', education_skills: 'Education & skills',
    healthcare: 'Health & healthcare', mobility_time: 'Mobility & time', world_context: 'World context',
  };

  // ------------------------------------------------------------------
  // State & helpers
  // ------------------------------------------------------------------

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const store = {
    get(k, d) { try { const v = localStorage.getItem('agentopia.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('agentopia.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = {
    snap: null,
    run: store.get('run', 'auto'),
    live: store.get('live', true),
    view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('view', 'overview'),
    citizenQuery: '', citizenSort: store.get('citizenSort', 'name'),
    placeQuery: '', placeFilter: store.get('placeFilter', 'occupied'),
    feedQuery: '', feedFilter: store.get('feedFilter', 'all'),
    drawer: null,            // { type: 'person' | 'place', id }
    drawerReturnFocus: null,
    fetchedAt: 0, lastWriteAt: 0,
    error: null, inFlight: false, timer: null,
    agentsByName: new Map(), placesByName: new Map(),
  };
  if (!VIEWS.includes(state.view)) state.view = 'overview';

  const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(v) || 0));
  const short = (t, n = 140) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
  const money = n => '$' + Math.round(Number(n) || 0).toLocaleString();
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const prettyKey = k => String(k).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

  function ago(seconds) {
    if (seconds == null || !isFinite(seconds)) return 'unknown';
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h ${m % 60} min ago`;
    return `${Math.floor(h / 24)} days ago`;
  }

  // "Y2020-W01-contact-S3" → { year, week, stage, day, slot }
  function parseTime(raw) {
    const m = /Y(\d+)-W(\d+)-([a-z_]+)(?:-([DS])(\d+))?/i.exec(String(raw || ''));
    if (!m) return null;
    return {
      year: +m[1], week: +m[2], stage: m[3].toLowerCase(),
      day: m[4] && m[4].toUpperCase() === 'D' ? +m[5] : null,
      slot: m[4] && m[4].toUpperCase() === 'S' ? +m[5] : null,
    };
  }
  function timeKey(raw) {
    const t = parseTime(raw);
    if (!t) return 0;
    return t.year * 1e6 + t.week * 1e3 + (PHASE_INDEX[t.stage] ?? 3) * 50 + (t.day || t.slot || 0);
  }
  // Agent files lag behind the engine, so prefer the newest "== X STAGE =="
  // marker from the engine log when it is ahead of the snapshot clock.
  function currentTime(s) {
    let best = s?.current_time || '';
    const lines = s?.engine?.log_tail || [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /== ([A-Z_]+) STAGE == year=(\d+) week=(\d+)(?: (slot|day)=(\d+))?/.exec(lines[i]);
      if (!m) continue;
      const raw = `Y${m[2]}-W${String(m[3]).padStart(2, '0')}-${m[1].toLowerCase()}` + (m[4] ? `-${m[4] === 'slot' ? 'S' : 'D'}${m[5]}` : '');
      if (timeKey(raw) > timeKey(best)) best = raw;
      break;
    }
    return best;
  }

  function timeLabel(raw, withPhase = true) {
    const t = parseTime(raw);
    if (!t) return raw ? String(raw) : '';
    const phase = PHASES[PHASE_INDEX[t.stage]];
    let s = `Week ${t.week}`;
    if (withPhase && phase) s += ` · ${phase.short}`;
    if (t.day) s += ` day ${t.day}`;
    if (t.slot) s += ` ${t.slot}`;
    return s;
  }

  // apartment_10131750 → "Apartment · started Oct 13, 17:50"
  function runLabel(name) {
    const m = /^(.*)_(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(name || ''));
    if (!m) return prettyKey(name || 'Unknown');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${prettyKey(m[1])} · started ${months[+m[2] - 1] || m[2]} ${+m[3]}, ${m[4]}:${m[5]}`;
  }

  const initialsOf = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  function hueFor(name) {
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 360;
  }
  function isLeader(a) { return a && (a.faction?.role === 'leader' || a.world_role === 'faction_leader'); }
  function avatar(nameOrAgent, size = '') {
    const a = typeof nameOrAgent === 'string' ? state.agentsByName.get(nameOrAgent) : nameOrAgent;
    const name = a ? a.name : String(nameOrAgent);
    const cls = ['avatar', size, isLeader(a) ? 'leader' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" style="--h:${hueFor(name)}" aria-hidden="true">${esc(a?.initials || initialsOf(name))}</span>`;
  }
  function bar(value, extra = '') {
    const v = clamp(value);
    const tone = v < 30 ? 'low' : v < 50 ? 'mid' : '';
    return `<div class="bar ${tone} ${extra}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v)}"><span style="width:${v}%"></span></div>`;
  }
  const empty = (title, text = '') => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;

  function placeName(key) {
    if (!key) return 'Unknown place';
    const loc = state.placesByName.get(key);
    if (loc) return loc.display_name || loc.name;
    return String(key).replace(/^home\//, '').replace(/^public\//, '');
  }
  function personBtn(name) {
    return state.agentsByName.has(name) ? `<button type="button" data-person="${esc(name)}">${esc(name)}</button>` : esc(name);
  }

  // Only touch the DOM when the markup actually changed, so hover states,
  // scroll positions and open <details> survive the 5-second refresh.
  function setHTML(el, html) {
    if (!el || el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------

  async function load() {
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      const res = await fetch(`/api/snapshot?run=${encodeURIComponent(state.run || 'auto')}&t=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `Server returned ${res.status}`);
      state.snap = data;
      state.error = null;
      state.fetchedAt = Date.now();
      const age = data.engine?.last_write_age;
      state.lastWriteAt = age == null ? 0 : Date.now() - age * 1000;
      state.agentsByName = new Map((data.agents || []).map(a => [a.name, a]));
      state.placesByName = new Map((data.locations || []).map(l => [l.name, l]));
    } catch (err) {
      state.error = err.message || String(err);
    } finally {
      state.inFlight = false;
      render();
      schedule();
    }
  }
  function schedule() {
    clearTimeout(state.timer);
    if (state.live) state.timer = setTimeout(load, REFRESH_MS);
  }

  // ------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------

  function feedItems() {
    const s = state.snap;
    if (!s) return [];
    const items = [];
    (s.messages || []).forEach((m, i) => {
      let text = String(m.content || '');
      let tag = '';
      const tm = /^\[([^\]]{1,80})\]\s*/.exec(text);
      if (tm) { tag = tm[1].replace(/\s*•\s*/, ' · '); text = text.slice(tm[0].length); }
      items.push({
        kind: m.stream_type === 'activity' ? 'activity' : 'message',
        time: m.time, key: timeKey(m.time), order: i,
        from: m.sender, to: m.recipient, text, tag,
      });
    });
    (s.public_events || []).forEach((e, i) => {
      items.push({
        kind: 'event', time: e.time, key: timeKey(e.time), order: i,
        title: e.event_name || 'World event', text: e.description || '', faction: !!e.faction_event,
      });
    });
    items.sort((a, b) => b.key - a.key || b.order - a.order);
    return items;
  }

  function averageNeeds(agents) {
    const out = {};
    for (const n of NEEDS) {
      const vals = agents.map(a => Number(a.state?.[n.key])).filter(v => isFinite(v));
      out[n.key] = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Rendering — shell
  // ------------------------------------------------------------------

  function render() {
    renderHeader();
    renderTabs();
    const s = state.snap;
    setHTML($('#banner'), state.error ? esc(`Can't load simulation data: ${state.error}. Retrying…`) : '');
    $('#banner').hidden = !state.error;
    if (s) {
      const fn = { overview: renderOverview, citizens: renderCitizens, places: renderPlaces,
        relationships: renderRelationships, activity: renderActivity, engine: renderEngine, systems: renderSystems }[state.view];
      fn && fn();
      if (state.drawer) renderDrawer();
    }
    tickClock();
  }

  function renderHeader() {
    const s = state.snap;
    const engineState = state.error ? 'offline' : (s?.engine?.state || 'stopped');
    const es = ENGINE_STATES[engineState] || { label: prettyKey(engineState), help: '' };
    const pill = $('#statusPill');
    pill.dataset.state = engineState;
    pill.title = es.help;
    $('#statusText').textContent = es.label;

    if (!s) return;
    $('#worldName').textContent = runLabel(s.run);

    const t = parseTime(currentTime(s)) || s.current_time_parsed;
    const phase = t ? PHASES[PHASE_INDEX[t.stage]] : null;
    $('#clockLabel').textContent = t ? `Year ${t.year} · Week ${t.week}` : 'Getting ready';
    let phaseText = phase ? phase.text : 'The world is being set up';
    if (t?.day) phaseText += ` (day ${t.day})`;
    if (t?.slot) phaseText += ` (round ${t.slot})`;
    $('#phaseLabel').textContent = phaseText;

    const cur = t ? PHASE_INDEX[t.stage] ?? -1 : -1;
    setHTML($('#phaseTrack'), PHASES.map((p, i) =>
      `<li class="${i < cur ? 'done' : i === cur ? 'current' : ''}" title="${esc(p.text)}"${i === cur ? ' aria-current="step"' : ''}>${esc(p.short)}</li>`).join(''));

    // Run picker: follow-latest plus every generated run.
    const runs = (s.runs || []).filter(r => r.generated);
    const opts = [`<option value="auto">Follow the latest run</option>`]
      .concat((runs.length ? runs : s.runs || []).map(r =>
        `<option value="${esc(r.name)}">${esc(runLabel(r.name))}${r.active ? ' (active)' : ''}</option>`));
    if (setHTML($('#runSelect'), opts.join(''))) $('#runSelect').value = state.run;
  }

  function renderTabs() {
    const s = state.snap;
    $$('.tab').forEach(b => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === state.view));
    if (!s) return;
    $('#countCitizens').textContent = (s.agents || []).length || '';
    $('#countPlaces').textContent = (s.locations || []).length || '';
    $('#countRelationships').textContent = (s.relationships || []).length || '';
    $('#countActivity').textContent = ((s.messages || []).length + (s.public_events || []).length) || '';
    const hasSystems = Object.keys(SYSTEM_MODULES).some(k => s[k] && Object.keys(s[k]).length);
    $('#systemsTab').hidden = !hasSystems;
  }

  function tickClock() {
    const parts = [];
    if (state.lastWriteAt) parts.push(`Simulation last wrote data ${ago((Date.now() - state.lastWriteAt) / 1000)}`);
    if (state.fetchedAt) parts.push(`dashboard refreshed ${ago((Date.now() - state.fetchedAt) / 1000)}`);
    if (!state.live) parts.push('live updates paused');
    $('#footerUpdated').textContent = parts.length ? parts.join(' · ') : 'Not updated yet';
  }

  // ------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------

  function renderOverview() {
    const s = state.snap;
    const agents = s.agents || [];
    const locs = s.locations || [];
    const t = parseTime(currentTime(s));
    const phase = t ? PHASES[PHASE_INDEX[t.stage]] : null;

    $('#nowHeadline').textContent = phase ? phase.text + '.' : 'The world is being set up.';
    const doing = {};
    agents.forEach(a => { if (a.activity) doing[a.activity] = (doing[a.activity] || 0) + 1; });
    const top = Object.entries(doing).sort((a, b) => b[1] - a[1])[0];
    $('#nowDetail').textContent = top
      ? `${plural(top[1], 'citizen is', 'citizens are')} currently “${short(top[0], 70)}”.`
      : 'Citizens will appear here once the simulation starts writing data.';

    const occupied = locs.filter(l => (l.occupied_count || 0) > 0);
    const convo = (s.messages || []).filter(m => m.stream_type !== 'activity').length;
    setHTML($('#overviewStats'), [
      ['Citizens', agents.length],
      ['Places in use', `${occupied.length}<span class="muted" style="font-size:.9rem">/${locs.length}</span>`],
      ['Messages', convo],
      ['World events', (s.public_events || []).length],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join(''));

    const busy = occupied.slice().sort((a, b) => (b.occupied_count || 0) - (a.occupied_count || 0)).slice(0, 8);
    setHTML($('#overviewPlaces'), busy.length ? busy.map(l => `
      <button class="place-mini" type="button" data-place="${esc(l.name)}">
        <span><span class="name">${esc(l.display_name || l.name)}</span><span class="sub">${esc(placeKind(l))}</span></span>
        ${avatarStack(l.occupant_names || [], 5)}
      </button>`).join('') : empty('Nobody is anywhere yet', 'Places fill up as citizens move around.'));

    const feed = feedItems().slice(0, 8);
    setHTML($('#overviewFeed'), feed.length ? feed.map(feedItem).join('') : `<li>${empty('Quiet so far', 'Conversations and events will show up here.')}</li>`);

    const avg = averageNeeds(agents);
    setHTML($('#overviewNeeds'), NEEDS.map(n => avg[n.key] == null ? '' : `
      <div class="need-row">
        <span class="label">${esc(n.label)}<small>${esc(n.hint)}</small></span>
        ${bar(avg[n.key])}
        <span class="val">${Math.round(avg[n.key])}</span>
      </div>`).join('') || empty('No data yet'));

    const low = agents.filter(a => a.state && isFinite(a.state.mood)).sort((a, b) => a.state.mood - b.state.mood).slice(0, 6);
    setHTML($('#overviewLowMood'), low.length ? low.map(a => `
      <li><button class="person-row" type="button" data-person="${esc(a.name)}">
        ${avatar(a, 'sm')}
        <span><span class="name">${esc(a.name)}</span><span class="sub">${esc(short(a.activity || jobTitle(a), 60))}</span></span>
        ${bar(a.state.mood, 'thin')}
      </button></li>`).join('') : `<li>${empty('No data yet')}</li>`);
  }

  function avatarStack(names, max = 5) {
    if (!names.length) return '<span class="muted" style="font-size:.8rem">empty</span>';
    const shown = names.slice(0, max).map(n => avatar(n, 'sm')).join('');
    const more = names.length > max ? `<span class="more">+${names.length - max}</span>` : '';
    return `<span class="avatar-stack" title="${esc(names.join(', '))}">${shown}${more}</span>`;
  }
  function placeKind(l) {
    const kind = l.hq ? 'Headquarters' : l.kind === 'private' ? 'Home' : l.kind === 'public' ? 'Public place' : prettyKey(l.kind || 'place');
    return l.size ? `${kind} · ${l.size}` : kind;
  }
  function jobTitle(a) { return String(a.job || '').split('@')[0].trim() || 'No job listed'; }

  function feedItem(it) {
    if (it.kind === 'event') {
      return `<li class="feed-item">
        <span class="event-icon" aria-hidden="true">✦</span>
        <div><div class="feed-meta"><span class="who">${esc(it.title)}</span><span class="tag accent">World event</span><time>${esc(timeLabel(it.time))}</time></div>
        <p class="feed-text">${esc(it.text)}</p></div></li>`;
    }
    const to = it.to ? `<span class="arrow">→</span><span class="who">${String(it.to).startsWith('Group:') ? esc(short(it.to, 60)) : personBtn(it.to)}</span>` : '';
    const tag = it.tag ? `<span class="tag">${esc(it.tag)}</span>` : '';
    return `<li class="feed-item">
      ${avatar(it.from)}
      <div><div class="feed-meta"><span class="who">${personBtn(it.from)}</span>${to}${tag}<time>${esc(timeLabel(it.time))}</time></div>
      <p class="feed-text">${esc(it.text)}</p></div></li>`;
  }

  // ------------------------------------------------------------------
  // Citizens
  // ------------------------------------------------------------------

  function renderCitizens() {
    const q = state.citizenQuery.trim().toLowerCase();
    let list = (state.snap.agents || []).filter(a => !q ||
      [a.name, a.job, a.activity, placeName(a.location)].some(v => String(v || '').toLowerCase().includes(q)));
    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name),
      mood: (a, b) => (a.state?.mood ?? 999) - (b.state?.mood ?? 999),
      social: (a, b) => (a.state?.social ?? 999) - (b.state?.social ?? 999),
      vitality: (a, b) => (a.state?.vitality ?? 999) - (b.state?.vitality ?? 999),
      money: (a, b) => (b.state?.deposit ?? -1) - (a.state?.deposit ?? -1),
    };
    list = list.slice().sort(sorters[state.citizenSort] || sorters.name);

    setHTML($('#citizenGrid'), list.length ? list.map(a => `
      <button class="citizen-card" type="button" data-person="${esc(a.name)}">
        <span class="top">${avatar(a)}<span style="min-width:0"><span class="name">${esc(a.name)}</span><span class="job">${esc(jobTitle(a))}</span></span></span>
        <span class="doing">${esc(a.activity || 'No current activity')}</span>
        <span class="where">📍 ${esc(placeName(a.location))}${a.state?.deposit != null ? ` · <span class="num">${money(a.state.deposit)}</span>` : ''}</span>
        <span class="mini-needs">${NEEDS.map(n => `<div><span>${esc(n.label)}</span>${bar(a.state?.[n.key], 'thin')}</div>`).join('')}</span>
      </button>`).join('') : empty('No citizens match', q ? 'Try a different search.' : 'The simulation has not created any citizens yet.'));
  }

  // ------------------------------------------------------------------
  // Places
  // ------------------------------------------------------------------

  function renderPlaces() {
    const q = state.placeQuery.trim().toLowerCase();
    const f = state.placeFilter;
    $$('[data-place-filter]').forEach(b => b.classList.toggle('active', b.dataset.placeFilter === f));
    let list = (state.snap.locations || []).filter(l => {
      if (f === 'occupied' && !(l.occupied_count > 0)) return false;
      if (f === 'public' && l.kind === 'private') return false;
      if (f === 'private' && l.kind !== 'private') return false;
      if (!q) return true;
      return [l.display_name, l.name, l.description, ...(l.occupant_names || [])].some(v => String(v || '').toLowerCase().includes(q));
    });
    list = list.slice().sort((a, b) => (b.occupied_count || 0) - (a.occupied_count || 0) || String(a.display_name).localeCompare(String(b.display_name)));

    setHTML($('#placeGrid'), list.length ? list.map(l => `
      <button class="place-card ${l.occupied_count > 0 ? 'has-people' : ''}" type="button" data-place="${esc(l.name)}">
        <span class="title"><strong>${esc(l.display_name || l.name)}</strong><span class="tag">${esc(placeKind(l))}</span></span>
        <p>${esc(l.description || 'No description.')}</p>
        <span class="foot">${l.occupied_count > 0 ? avatarStack(l.occupant_names || [], 6) : '<span class="nobody">Nobody here right now</span>'}
          <span class="muted num" style="font-size:.8rem">${l.occupied_count > 0 ? plural(l.occupied_count, 'person', 'people') : ''}</span></span>
      </button>`).join('') : empty('No places match', f === 'occupied' ? 'Nobody is in a place right now. Try “All”.' : 'Try a different search or filter.'));
  }

  // ------------------------------------------------------------------
  // Relationships
  // ------------------------------------------------------------------

  function renderRelationships() {
    const rels = (state.snap.relationships || []).slice(0, 80);
    const svg = $('#relGraph');
    if (!rels.length) {
      setHTML(svg, `<text class="empty-text" x="400" y="310" text-anchor="middle">No conversations yet.</text>
        <text class="empty-text" x="400" y="336" text-anchor="middle" style="font-size:13px;opacity:.7">Lines appear here once citizens start talking.</text>`);
      setHTML($('#relList'), `<li>${empty('No pairs yet')}</li>`);
      return;
    }
    const degree = new Map();
    rels.forEach(r => { degree.set(r.a, (degree.get(r.a) || 0) + r.interactions); degree.set(r.b, (degree.get(r.b) || 0) + r.interactions); });
    const names = [...degree.keys()].sort((a, b) => degree.get(b) - degree.get(a)).slice(0, 40).sort();
    const keep = new Set(names);
    const cx = 400, cy = 320, R = Math.min(250, 90 + names.length * 7);
    const pos = new Map(names.map((n, i) => {
      const ang = (i / names.length) * Math.PI * 2 - Math.PI / 2;
      return [n, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), ang }];
    }));
    const maxDeg = Math.max(...names.map(n => degree.get(n)));
    const edges = rels.filter(r => keep.has(r.a) && keep.has(r.b)).map(r => {
      const p = pos.get(r.a), q = pos.get(r.b), w = clamp(r.strength, 0, 1);
      return `<path class="edge" d="M${p.x.toFixed(1)},${p.y.toFixed(1)} Q${cx},${cy} ${q.x.toFixed(1)},${q.y.toFixed(1)}" fill="none" stroke-width="${(1 + w * 5).toFixed(1)}" stroke-opacity="${(0.18 + w * 0.6).toFixed(2)}"><title>${esc(r.a)} ↔ ${esc(r.b)}: ${r.interactions} messages</title></path>`;
    }).join('');
    const nodes = names.map(n => {
      const p = pos.get(n), r = 12 + 10 * (degree.get(n) / maxDeg);
      const cos = Math.cos(p.ang), lx = p.x + cos * (r + 8), ly = p.y + Math.sin(p.ang) * (r + 8) + 4;
      const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
      return `<g class="node" data-person="${esc(n)}" tabindex="0" role="button" aria-label="${esc(n)}">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"></circle>
        <text class="initials" x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle">${esc(initialsOf(n))}</text>
        <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(short(n, 22))}</text></g>`;
    }).join('');
    setHTML(svg, edges + nodes);

    const max = rels[0].interactions || 1;
    setHTML($('#relList'), rels.slice(0, 15).map(r => `
      <li><span class="names">${personBtn(r.a)} <span class="muted">&amp;</span> ${personBtn(r.b)}</span>
      <span class="num muted" style="font-size:.8rem">${r.interactions}</span>${bar(100 * r.interactions / max, 'thin')}</li>`).join(''));
  }

  // ------------------------------------------------------------------
  // Activity
  // ------------------------------------------------------------------

  function renderActivity() {
    const q = state.feedQuery.trim().toLowerCase();
    const f = state.feedFilter;
    $$('[data-feed-filter]').forEach(b => b.classList.toggle('active', b.dataset.feedFilter === f));
    const items = feedItems().filter(it => (f === 'all' || it.kind === f) &&
      (!q || [it.from, it.to, it.text, it.title, it.tag].some(v => String(v || '').toLowerCase().includes(q))));
    setHTML($('#activityFeed'), items.length ? items.slice(0, 200).map(feedItem).join('')
      : `<li>${empty('Nothing here yet', q || f !== 'all' ? 'Try a different search or filter.' : 'Conversations start during the “Talk” phase of each week.')}</li>`);
  }

  // ------------------------------------------------------------------
  // Engine
  // ------------------------------------------------------------------

  function renderEngine() {
    const s = state.snap, e = s.engine || {};
    const es = ENGINE_STATES[e.state] || { label: prettyKey(e.state || 'unknown'), help: '' };
    const t = parseTime(currentTime(s));
    const facts = [
      ['Status', `${esc(es.label)} <span class="muted">— ${esc(es.help)}</span>`],
      ['Simulation time', esc(t ? `Year ${t.year}, ${timeLabel(currentTime(s))}` : 'Not started')],
      ['Last data write', esc(e.last_write_age == null ? 'never' : ago(e.last_write_age))],
      ['Last file written', `<span class="num">${esc(e.last_write_path || '—')}</span>`],
      ['Run folder', `<span class="num">${esc(s.run || '—')}</span>`],
      ['Citizens', `<span class="num">${(s.agents || []).length}</span>`],
    ];
    setHTML($('#engineFacts'), facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join(''));

    const advice = {
      stopped: 'The simulation isn\'t running. Double-click RUN-SIM.bat in the Agentopia folder to start it. It will continue from where it left off only if you pass --resume.',
      thinking: 'The engine is waiting for the AI model to answer. With a local model each step can take a while — that\'s normal.',
      waiting: 'Nothing has been written for a few minutes. Big steps (like everyone planning their week) can be slow on a local model. If this lasts more than ~30 minutes, check the log for errors.',
      booting: 'The simulation is starting up. This usually takes a minute or two.',
    }[e.state] || '';
    $('#engineAdvice').textContent = advice;
    const lines = (e.log_tail || []).map(l => String(l).replace(/^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}),\d+ - /, '$1  '));
    setHTML($('#engineLog'), esc(lines.length ? lines.join('\n') : 'No log output yet.'));
  }

  // ------------------------------------------------------------------
  // Systems (optional Detroit modules)
  // ------------------------------------------------------------------

  function renderSystems() {
    const s = state.snap;
    const cards = Object.entries(SYSTEM_MODULES).filter(([k]) => s[k] && Object.keys(s[k]).length).map(([k, label]) => {
      const rows = [];
      const visit = (obj, prefix) => {
        for (const [key, v] of Object.entries(obj)) {
          if (rows.length >= 12) return;
          if (v == null || typeof v === 'object') {
            if (v && !Array.isArray(v) && !prefix) visit(v, key);
            continue;
          }
          rows.push([prefix ? `${prettyKey(prefix)} · ${key.replace(/_/g, ' ')}` : prettyKey(key), typeof v === 'number' ? v.toLocaleString() : short(v, 40)]);
        }
      };
      visit(s[k], '');
      return `<section class="card"><header class="card-head"><h2>${esc(label)}</h2></header>
        ${rows.length ? `<dl class="facts">${rows.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>` : empty('No summary values')}</section>`;
    });
    setHTML($('#systemsGrid'), cards.join('') || empty('No extra systems are reporting for this run'));
  }

  // ------------------------------------------------------------------
  // Drawer
  // ------------------------------------------------------------------

  function openDrawer(type, id) {
    if (!state.drawer) state.drawerReturnFocus = document.activeElement;
    state.drawer = { type, id };
    const d = $('#drawer');
    $('#drawerHeader')._html = $('#drawerBody')._html = null;
    renderDrawer();
    $('#drawerBody').scrollTop = 0;
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    $('#drawerScrim').hidden = false;
    d.focus();
  }
  function closeDrawer() {
    state.drawer = null;
    const d = $('#drawer');
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    $('#drawerScrim').hidden = true;
    if (state.drawerReturnFocus?.isConnected) state.drawerReturnFocus.focus();
  }

  function renderDrawer() {
    const { type, id } = state.drawer;
    let head, body;
    if (type === 'person') {
      const a = state.agentsByName.get(id);
      if (!a) { head = `<h2 id="drawerTitle">${esc(id)}</h2>`; body = empty('This citizen is not in the current run'); }
      else [head, body] = personDrawer(a);
    } else {
      const l = state.placesByName.get(id);
      if (!l) { head = `<h2 id="drawerTitle">${esc(id)}</h2>`; body = empty('This place is not in the current run'); }
      else [head, body] = placeDrawer(l);
    }
    setHTML($('#drawerHeader'), head);
    // Preserve which folds are open across live refreshes.
    const bodyEl = $('#drawerBody');
    const open = new Set($$('details[open]', bodyEl).map(d => d.dataset.key));
    if (setHTML(bodyEl, body)) $$('details', bodyEl).forEach(d => { if (open.has(d.dataset.key)) d.open = true; });
  }

  function fold(key, title, content) {
    return `<details class="fold" data-key="${esc(key)}"><summary>${esc(title)}</summary><div class="fold-body">${esc(content)}</div></details>`;
  }

  function personDrawer(a) {
    const st = a.state || {};
    const faction = a.faction?.name ? `<span class="tag accent">${esc(a.faction.name)}${a.faction.role ? ' · ' + esc(a.faction.role) : ''}</span>` : '';
    const head = `${avatar(a, 'lg')}<div style="min-width:0"><h2 id="drawerTitle">${esc(a.name)}</h2><p>${esc(a.job || 'No job listed')}</p>${faction ? `<div style="margin-top:6px">${faction}</div>` : ''}</div>`;

    const sections = [];
    sections.push(`<section class="drawer-section"><h3>Right now</h3><div class="now-box">
      <strong>${esc(a.activity || 'No current activity')}</strong>
      <div class="where">at <button type="button" data-place="${esc(a.location || '')}">${esc(placeName(a.location))}</button>${a.activity_time ? ` · ${esc(timeLabel(a.activity_time))}` : ''}</div>
      ${a.outcome ? `<p style="margin-top:8px">${esc(a.outcome)}</p>` : ''}</div></section>`);

    if (a.intro) sections.push(`<section class="drawer-section"><h3>About</h3><p>${esc(a.intro)}</p></section>`);

    if (NEEDS.some(n => st[n.key] != null)) {
      sections.push(`<section class="drawer-section"><h3>How they're doing</h3><div class="needs">${NEEDS.map(n => st[n.key] == null ? '' : `
        <div class="need-row"><span class="label">${esc(n.label)}<small>${esc(n.hint)}</small></span>${bar(st[n.key])}<span class="val">${Math.round(st[n.key])}</span></div>`).join('')}</div></section>`);
    }

    const possessions = Array.isArray(st.possessions) ? st.possessions : [];
    const skills = Object.entries(st.skills || {}).filter(([, v]) => isFinite(v)).sort((x, y) => y[1] - x[1]);
    sections.push(`<section class="drawer-section"><h3>Money & belongings</h3><div class="kv">
      <div><span>Savings</span><strong>${st.deposit != null ? money(st.deposit) : '—'}</strong></div>
      <div><span>Possessions</span><strong>${possessions.length}</strong></div>
      <div><span>Skills</span><strong>${skills.length}</strong></div></div></section>`);

    if (skills.length) {
      const top = Math.max(100, skills[0][1]);
      sections.push(`<section class="drawer-section"><h3>Skills</h3><div class="skill-list">${skills.slice(0, 10).map(([k, v]) => `
        <div class="skill-row"><span>${esc(prettyKey(k))}</span><div class="bar thin"><span style="width:${clamp(100 * v / top)}%"></span></div><span class="val">${Math.round(v)}</span></div>`).join('')}</div></section>`);
    }

    if (possessions.length) {
      sections.push(`<section class="drawer-section"><h3>Belongings</h3><ul class="item-list">${possessions.slice(0, 12).map(p => typeof p === 'string'
        ? `<li><strong>${esc(p)}</strong></li>`
        : `<li><strong>${esc(p.name || 'Item')}</strong>${p.description ? ` — ${esc(short(p.description, 160))}` : ''}</li>`).join('')}</ul></section>`);
    }

    const prof = a.profile || {};
    const profParts = [['core_motivation', 'What drives them'], ['values', 'What they value'], ['conflicts', 'Inner conflicts'], ['preferences', 'Likes & preferences']]
      .filter(([k]) => prof[k]).map(([k, label]) => fold('prof-' + k, label, typeof prof[k] === 'string' ? prof[k] : JSON.stringify(prof[k], null, 2)));
    if (profParts.length) sections.push(`<section class="drawer-section"><h3>Personality</h3>${profParts.join('')}</section>`);

    const mems = (a.memories || []).filter(m => m.person);
    if (mems.length) {
      sections.push(`<section class="drawer-section"><h3>People they know (${mems.length})</h3>
        <div class="person-chips" style="margin-bottom:10px">${mems.map(m => state.agentsByName.has(m.person)
          ? `<button class="person-chip" type="button" data-person="${esc(m.person)}">${avatar(m.person, 'sm')}${esc(m.person)}</button>`
          : `<span class="person-chip">${avatar(m.person, 'sm')}${esc(m.person)}</span>`).join('')}</div>
        ${mems.slice(0, 12).map(m => fold('mem-' + m.person, `What ${a.name.split(' ')[0]} thinks of ${m.person}`, String(m.summary || '').replace(/^Character:.*\n/, '').replace(/^Perception:\s*/, ''))).join('')}</section>`);
    }

    const msgs = feedItems().filter(it => it.kind !== 'event' && (it.from === a.name || it.to === a.name)).slice(0, 10);
    sections.push(`<section class="drawer-section"><h3>Recent conversations</h3>${msgs.length ? `<ol class="feed compact">${msgs.map(feedItem).join('')}</ol>` : empty('No conversations yet')}</section>`);

    return [head, sections.join('')];
  }

  function placeDrawer(l) {
    const head = `<span class="event-icon" style="width:56px;height:56px;border-radius:16px;font-size:1.3rem" aria-hidden="true">${l.kind === 'private' ? '⌂' : l.hq ? '★' : '◆'}</span>
      <div style="min-width:0"><h2 id="drawerTitle">${esc(l.display_name || l.name)}</h2><p>${esc(placeKind(l))}${l.owner ? ` · owned by ${esc(l.owner)}` : ''}</p></div>`;
    const occ = l.occupant_names || [];
    const sections = [];
    if (l.description) sections.push(`<section class="drawer-section"><h3>About this place</h3><p>${esc(l.description)}</p></section>`);
    sections.push(`<section class="drawer-section"><h3>Here now (${occ.length})</h3>${occ.length
      ? `<div class="person-chips">${occ.map(n => `<button class="person-chip" type="button" data-person="${esc(n)}">${avatar(n, 'sm')}${esc(n)}</button>`).join('')}</div>`
      : empty('Nobody is here right now')}</section>`);
    if (l.member_names?.length) {
      sections.push(`<section class="drawer-section"><h3>Members (${l.member_names.length})</h3><div class="person-chips">${l.member_names.map(n => `<button class="person-chip" type="button" data-person="${esc(n)}">${avatar(n, 'sm')}${esc(n)}</button>`).join('')}</div></section>`);
    }
    if (l.objects?.length) {
      sections.push(`<section class="drawer-section"><h3>What's inside</h3><div class="person-chips">${l.objects.map(o => `<span class="tag">${esc(typeof o === 'string' ? o : o.name || '')}</span>`).join('')}</div></section>`);
    }
    const here = new Set(occ);
    const msgs = feedItems().filter(it => it.kind !== 'event' && here.has(it.from) && (here.has(it.to) || String(it.to || '').startsWith('Group:'))).slice(0, 10);
    sections.push(`<section class="drawer-section"><h3>Recent conversations between people here</h3>${msgs.length ? `<ol class="feed compact">${msgs.map(feedItem).join('')}</ol>` : empty('No conversations between these people yet')}</section>`);
    return [head, sections.join('')];
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  function setView(view) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    store.set('view', view);
    if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
    render();
    window.scrollTo({ top: 0 });
  }

  document.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) return setView(tab.dataset.view);
    const go = e.target.closest('[data-goto]');
    if (go) return setView(go.dataset.goto);
    const person = e.target.closest('[data-person]');
    if (person) return openDrawer('person', person.dataset.person);
    const place = e.target.closest('[data-place]');
    if (place && place.dataset.place) return openDrawer('place', place.dataset.place);
    const pf = e.target.closest('[data-place-filter]');
    if (pf) { state.placeFilter = pf.dataset.placeFilter; store.set('placeFilter', state.placeFilter); return renderPlaces(); }
    const ff = e.target.closest('[data-feed-filter]');
    if (ff) { state.feedFilter = ff.dataset.feedFilter; store.set('feedFilter', state.feedFilter); return renderActivity(); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.drawer) closeDrawer();
    const node = e.target.closest?.('#relGraph .node');
    if (node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer('person', node.dataset.person); }
  });

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);

  $('#citizenSearch').addEventListener('input', e => { state.citizenQuery = e.target.value; state.snap && renderCitizens(); });
  $('#citizenSort').value = state.citizenSort;
  $('#citizenSort').addEventListener('change', e => { state.citizenSort = e.target.value; store.set('citizenSort', state.citizenSort); state.snap && renderCitizens(); });
  $('#placeSearch').addEventListener('input', e => { state.placeQuery = e.target.value; state.snap && renderPlaces(); });
  $('#activitySearch').addEventListener('input', e => { state.feedQuery = e.target.value; state.snap && renderActivity(); });

  $('#runSelect').addEventListener('change', e => {
    state.run = e.target.value;
    store.set('run', state.run);
    if (state.drawer) closeDrawer();
    load();
  });
  $('#refreshBtn').addEventListener('click', load);
  const liveBtn = $('#liveToggle');
  function syncLive() {
    liveBtn.setAttribute('aria-pressed', String(state.live));
    $('#liveLabel').textContent = state.live ? 'Live' : 'Paused';
  }
  liveBtn.addEventListener('click', () => {
    state.live = !state.live;
    store.set('live', state.live);
    syncLive();
    state.live ? load() : clearTimeout(state.timer);
    tickClock();
  });
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== state.view) setView(v); });

  syncLive();
  setInterval(tickClock, 1000);
  render();
  load();
})();
