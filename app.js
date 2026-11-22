'use strict';
/*
 * Notas — notas con tareas y recordatorios, sincronizadas entre dispositivos.
 *
 * Modelo (sacado de cómo lo hace Apple Notes, ver docs/rea-apple-notes.md):
 *  - Todo es un "item": carpeta, nota o línea. Una tarea es una línea con task=true.
 *  - El título de una nota es su primera línea.
 *  - Cada item se sincroniza por separado y gana el cambio más reciente (reloj híbrido),
 *    así que editar líneas distintas de la misma nota en dos dispositivos nunca choca.
 *  - Primero se guarda en el dispositivo (IndexedDB) y luego se sube: funciona sin conexión.
 *  - Una línea con remind_at es un recordatorio: la función "gcal" lo pone en Google Calendar.
 */

const CFG = window.NOTAS_CONFIG || {};
const HAS_CLOUD = !!(CFG.url && CFG.anonKey && window.supabase);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const DAY = 864e5;

/* ---------- Orden fraccional: una clave entre a y b sin renumerar nada ---------- */
const DIG = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function between(a = '', b = '') {
  if (b && a >= b) b = '';
  let out = '', bInf = !b;
  for (let i = 0; ; i++) {
    const da = i < a.length ? DIG.indexOf(a[i]) : 0;
    const db = bInf ? DIG.length : (i < b.length ? DIG.indexOf(b[i]) : 0);
    if (db - da > 1) return out + DIG[(da + db) >> 1];
    out += DIG[da];
    if (db - da === 1) bInf = true;
  }
}

/* ---------- Almacén local (IndexedDB) ---------- */
const store = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('notas', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all() { return this.req(this.db.transaction('items').objectStore('items').getAll()); },
  getMeta() { return this.req(this.db.transaction('meta').objectStore('meta').get('meta')); },
  write(items, meta) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(['items', 'meta'], 'readwrite');
      for (const it of items) tx.objectStore('items').put(it);
      if (meta) tx.objectStore('meta').put(meta, 'meta');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  clear() {
    return new Promise((res) => {
      const tx = this.db.transaction(['items', 'meta'], 'readwrite');
      tx.objectStore('items').clear(); tx.objectStore('meta').clear(); tx.oncomplete = res;
    });
  },
};

/* ---------- Estado ---------- */
const S = {
  items: new Map(),
  meta: { device: '', cursor: 0, clock: 0, outbox: [], gcal: [] },
  outbox: new Set(),
  gcal: new Set(),   // líneas cuyo recordatorio hay que llevar a Google Calendar
  dirty: new Set(),
  view: { folder: 'all', note: null, q: '' },
  sb: null,
  session: null,
};
let children = null; // índice parent_id -> items, se rehace cuando algo cambia

function tick() { const t = Math.max(Date.now(), S.meta.clock + 1); S.meta.clock = t; return t; }
function touch(it) {
  it.updated_at = tick(); it.device = S.meta.device;
  S.items.set(it.id, it); S.outbox.add(it.id); S.dirty.add(it.id);
  children = null; persistSoon(); syncSoon();
}
function create(kind, fields) {
  const it = { id: crypto.randomUUID(), kind, parent_id: null, pos: '', text: '', task: false, done: false, pinned: false, deleted: 0, remind_at: null, ...fields };
  touch(it); if (it.remind_at) S.gcal.add(it.id); return it;
}
function update(it, patch) {
  let changed = false;
  const hadRemind = it.kind === 'line' && it.remind_at;
  for (const k in patch) if (it[k] !== patch[k]) { it[k] = patch[k]; changed = true; }
  if (!changed) return;
  touch(it);
  if (it.kind === 'line' && (hadRemind || it.remind_at)) S.gcal.add(it.id);
  if (it.kind === 'note' && 'deleted' in patch) for (const l of kids(it.id)) if (l.remind_at) S.gcal.add(l.id);
}

function kids(parentId) {
  if (!children) {
    children = new Map();
    for (const it of S.items.values()) {
      const k = it.parent_id || '';
      if (!children.has(k)) children.set(k, []);
      children.get(k).push(it);
    }
  }
  return children.get(parentId || '') || [];
}
const byPos = (a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1);
const linesOf = (noteId) => kids(noteId).filter((l) => l.kind === 'line' && !l.deleted).sort(byPos);
const folders = () => [...S.items.values()].filter((f) => f.kind === 'folder' && !f.deleted).sort((a, b) => a.text.localeCompare(b.text, 'es'));
const notes = () => [...S.items.values()].filter((n) => n.kind === 'note');
function noteInfo(n) {
  const ls = linesOf(n.id);
  let mod = n.updated_at, open = 0, total = 0;
  for (const l of ls) { if (l.updated_at > mod) mod = l.updated_at; if (l.task) { total++; if (!l.done) open++; } }
  const title = (ls[0] && ls[0].text.trim()) || 'Nota nueva';
  const rest = ls.slice(1).find((l) => l.text.trim());
  return { ls, mod, open, total, title, snippet: rest ? rest.text.trim() : 'Sin texto adicional' };
}
const isEmptyNote = (n) => linesOf(n.id).every((l) => !l.text.trim() && !l.remind_at);

/* ---------- Guardado local ---------- */
let persistTimer = null;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 250); }
async function persist() {
  const items = [...S.dirty].map((id) => S.items.get(id)).filter(Boolean);
  S.dirty.clear();
  S.meta.outbox = [...S.outbox];
  S.meta.gcal = [...S.gcal];
  await store.write(items, S.meta);
}

/* ---------- Sincronización ---------- */
let syncTimer = null, syncing = false, again = false, backoff = 2000, channel = null, gcalState = 'unknown';
function syncSoon(ms = 700) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
function setStatus(s, title) { const el = $('#sync'); el.className = 'sync ' + s; el.title = title; }
const newer = (a, b) => a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.device > b.device);
const FIELDS = ['id', 'kind', 'parent_id', 'pos', 'text', 'task', 'done', 'pinned', 'deleted', 'remind_at', 'updated_at', 'device'];

async function sync() {
  if (!S.sb || !S.session) { setStatus('off', HAS_CLOUD ? 'Sin sesión' : 'Solo en este dispositivo'); return; }
  if (!navigator.onLine) { setStatus('off', 'Sin conexión: se guarda aquí y se sube al volver'); return; }
  if (syncing) { again = true; return; }
  syncing = true; again = false;
  setStatus('busy', 'Sincronizando…');
  try {
    // 1. Subir lo pendiente
    const ids = [...S.outbox];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200).map((id) => S.items.get(id)).filter(Boolean);
      const sent = new Map(batch.map((it) => [it.id, it.updated_at]));
      const rows = batch.map((it) => Object.fromEntries(FIELDS.map((f) => [f, it[f] === undefined ? null : it[f]])));
      const { error } = await S.sb.rpc('push_items', { rows });
      if (error) throw error;
      for (const [id, v] of sent) if (S.items.get(id).updated_at === v) S.outbox.delete(id);
    }
    // 2. Bajar lo nuevo. Se repasan los últimos 100 por si una escritura llegó desordenada.
    let from = Math.max(0, S.meta.cursor - 100), changed = false;
    for (;;) {
      const { data, error } = await S.sb.from('items').select(FIELDS.join(',') + ',seq').gt('seq', from).order('seq').limit(500);
      if (error) throw error;
      for (const r of data) {
        from = Math.max(from, r.seq);
        delete r.seq;
        const local = S.items.get(r.id);
        if (r.updated_at > S.meta.clock) S.meta.clock = r.updated_at;
        if (!local || newer(r, local)) { S.items.set(r.id, r); S.dirty.add(r.id); S.outbox.delete(r.id); changed = true; }
      }
      if (data.length < 500) break;
    }
    S.meta.cursor = Math.max(S.meta.cursor, from);
    // 3. Recordatorios a Google Calendar (solo los que ya están subidos)
    await pushCalendar();
    await persist();
    if (changed) { children = null; render(); }
    backoff = 2000;
    setStatus(S.outbox.size ? 'busy' : 'ok', S.outbox.size ? 'Cambios pendientes' : 'Sincronizado');
  } catch (e) {
    console.warn('[notas] sync', e);
    setStatus('err', 'Error al sincronizar, se reintenta: ' + (e.message || e));
    syncSoon(backoff); backoff = Math.min(backoff * 2, 60000);
  } finally {
    syncing = false;
    if (again) syncSoon(100);
  }
}

async function pushCalendar() {
  const ids = [...S.gcal].filter((id) => !S.outbox.has(id));
  if (!ids.length || gcalState === 'off') return;
  const { data, error } = await S.sb.functions.invoke('gcal', { body: { ids } });
  if (error) {
    const status = error.context && error.context.status;
    if (status === 503) { gcalState = 'off'; renderGcal(); return; } // aún sin conectar: se guardan para luego
    console.warn('[notas] gcal', error); return;
  }
  gcalState = 'on'; renderGcal();
  for (const r of (data && data.results) || []) if (!r.error) S.gcal.delete(r.id);
}
function renderGcal() {
  const b = $('#gcalBtn');
  b.hidden = !S.session;
  b.textContent = gcalState === 'on' ? 'Google Calendar conectado' : gcalState === 'off' ? 'Google Calendar sin conectar' : '';
  b.classList.toggle('danger', gcalState === 'off');
}

function listenRealtime() {
  if (channel) S.sb.removeChannel(channel);
  channel = S.sb.channel('items-' + S.session.user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: 'user_id=eq.' + S.session.user.id }, () => syncSoon(150))
    .subscribe();
}

/* ---------- Navegación ---------- */
const app = $('#app');
const wide = () => matchMedia('(min-width: 900px)').matches;
function go(pane) {
  if (app.dataset.pane === pane) return;
  app.dataset.pane = pane;
  if (!wide()) history.pushState({ pane }, '');
}
addEventListener('popstate', (e) => {
  const pane = (e.state && e.state.pane) || 'list';
  if (app.dataset.pane === 'editor' && pane !== 'editor') leaveNote();
  app.dataset.pane = pane;
  closeMenu();
});
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
  if (history.state && history.state.pane === app.dataset.pane && history.length > 1) history.back();
  else { if (app.dataset.pane === 'editor') leaveNote(); app.dataset.pane = b.dataset.go; history.replaceState({ pane: b.dataset.go }, ''); }
}));

function selectFolder(f) {
  S.view.folder = f; $('#search').value = ''; S.view.q = '';
  render(); go('list');
}
function openNote(id) {
  if (S.view.note && S.view.note !== id) leaveNote();
  S.view.note = id;
  renderList(); renderEditor(true);
  go('editor');
}
function leaveNote() {
  const n = S.items.get(S.view.note);
  if (n && n.deleted === 0 && isEmptyNote(n)) purgeNote(n); // como Notas: una nota vacía no se queda
}
function newNote() {
  const fo = S.items.get(S.view.folder);
  const parent = fo && fo.kind === 'folder' ? fo.id : null;
  if (S.view.folder === 'trash' || S.view.folder === 'tasks') S.view.folder = 'all';
  const n = create('note', { parent_id: parent });
  const l = create('line', { parent_id: n.id, pos: between('', '') });
  openNote(n.id); focusLine(l.id, 0); renderSide();
}
function purgeNote(n) {
  for (const l of kids(n.id)) if (l.deleted !== 2) update(l, { deleted: 2, text: '' });
  update(n, { deleted: 2 });
  if (S.view.note === n.id) S.view.note = null;
}

/* ---------- Fechas ---------- */
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function fmtDate(ms) {
  const d = new Date(ms), today = startOfDay(new Date());
  if (ms >= today) return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (ms >= today - DAY) return 'Ayer';
  if (ms >= today - 6 * DAY) return d.toLocaleDateString('es-ES', { weekday: 'long' });
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric', year: '2-digit' });
}
function sectionOf(ms) { // como la lista de Notas: Hoy, Ayer, 7 días previos, 30 días previos, meses, años
  const today = startOfDay(new Date()), d = new Date(ms), now = new Date();
  if (ms >= today) return 'Hoy';
  if (ms >= today - DAY) return 'Ayer';
  if (ms >= today - 7 * DAY) return '7 días previos';
  if (ms >= today - 30 * DAY) return '30 días previos';
  if (d.getFullYear() === now.getFullYear()) { const m = d.toLocaleDateString('es-ES', { month: 'long' }); return m[0].toUpperCase() + m.slice(1); }
  return String(d.getFullYear());
}
function fmtRemind(ms) {
  const d = new Date(ms), today = startOfDay(new Date());
  const hm = d.toLocaleTimeString('es-ES', { hour: 'numeric', minute: '2-digit' });
  if (ms >= today && ms < today + DAY) return 'Hoy, ' + hm;
  if (ms >= today + DAY && ms < today + 2 * DAY) return 'Mañana, ' + hm;
  if (ms >= today - DAY && ms < today) return 'Ayer, ' + hm;
  if (ms > today && ms < today + 7 * DAY) return d.toLocaleDateString('es-ES', { weekday: 'short' }) + ', ' + hm;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ', ' + hm;
}
const remChip = (l) => `<span class="rem${!l.done && l.remind_at < Date.now() ? ' late' : ''}">${icon('bell')}${fmtRemind(l.remind_at)}</span>`;

/* ---------- Pintado: carpetas y lista ---------- */
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderSide(); renderList(); renderEditor(false); });
}

const openTaskLines = () => [...S.items.values()].filter((l) => l.kind === 'line' && l.task && !l.done && !l.deleted && S.items.get(l.parent_id)?.deleted === 0);

function renderSide() {
  const ns = notes();
  const alive = ns.filter((n) => n.deleted === 0);
  const row = (id, ic, name, count) =>
    `<button class="folder${S.view.folder === id ? ' sel' : ''}" data-f="${id}">${icon(ic)}<span class="name">${esc(name)}</span><span class="count">${count || ''}</span><svg class="chev"><use href="#i-chev"/></svg></button>`;
  let h = row('all', 'folder', 'Todas las notas', alive.length) + row('tasks', 'tasks', 'Tareas', openTaskLines().length);
  for (const f of folders()) h += row(f.id, 'folder', f.text || 'Sin nombre', alive.filter((n) => n.parent_id === f.id).length);
  h += row('trash', 'trash', 'Eliminadas', ns.filter((n) => n.deleted === 1).length);
  $('#folders').innerHTML = h;
  const sel = $('#moveSel');
  sel.innerHTML = '<option value="">Sin carpeta</option>' + folders().map((f) => `<option value="${f.id}">${esc(f.text || 'Sin nombre')}</option>`).join('');
  const n = S.items.get(S.view.note);
  if (n) sel.value = n.parent_id || '';
}

function folderTitle() {
  const f = S.view.folder, fo = S.items.get(f);
  if (f === 'tasks') return 'Tareas';
  if (f === 'trash') return 'Eliminadas';
  if (fo && fo.kind === 'folder' && !fo.deleted) return fo.text || 'Sin nombre';
  S.view.folder = 'all';
  return 'Todas las notas';
}

function renderList() {
  const title = folderTitle();
  const f = S.view.folder, fo = S.items.get(f);
  const isFolder = !!(fo && fo.kind === 'folder');
  const lt = $('#listTitle');
  if (document.activeElement !== lt) lt.value = title;
  lt.readOnly = !isFolder;
  $('#listTitleSmall').textContent = title;
  $('#backName').textContent = title;
  $('#folderDelBtn').hidden = !isFolder;
  $('#quickTask').hidden = f !== 'tasks';
  const q = norm(S.view.q.trim());

  if (f === 'tasks') return renderTasks(q);

  const ns = notes().filter((n) => (f === 'trash' ? n.deleted === 1 : n.deleted === 0) && (!isFolder || n.parent_id === f));
  let infos = ns.map((n) => ({ n, ...noteInfo(n) }));
  if (q) infos = infos.filter((x) => x.ls.some((l) => norm(l.text).includes(q)));
  infos.sort((a, b) => b.mod - a.mod);
  const count = infos.length === 1 ? '1 nota' : `${infos.length} notas`;
  $('#listCount').textContent = count; $('#countFoot').textContent = count;

  const card = (x) => `<button class="note${x.n.id === S.view.note ? ' sel' : ''}" data-n="${x.n.id}">
      <div class="t">${x.total ? `<span class="tc">${x.total - x.open}/${x.total}</span>` : ''}${esc(x.title)}</div>
      <div class="m"><b>${fmtDate(x.mod)}</b>${esc(x.snippet)}</div></button>`;
  const pinned = f !== 'trash' ? infos.filter((x) => x.n.pinned) : [];
  const sections = [];
  if (pinned.length) sections.push([`<span class="pin">${icon('pin')}</span>Fijadas`, pinned]);
  for (const x of infos) {
    if (pinned.includes(x)) continue;
    const s = sectionOf(x.mod);
    const last = sections[sections.length - 1];
    if (last && last[0] === s) last[1].push(x); else sections.push([s, [x]]);
  }
  let h = sections.map(([s, xs]) => `<div class="sect${s.includes('pin') ? ' pin' : ''}">${s}</div><div class="cards">${xs.map(card).join('')}</div>`).join('');
  if (!infos.length) h = `<div class="nores">${q ? 'Ningún resultado' : f === 'trash' ? 'No hay notas eliminadas' : 'No hay notas'}</div>`;
  $('#notes').innerHTML = h;
}

const recentlyDone = new Set();
function renderTasks(q) {
  const match = (l) => (!l.done || recentlyDone.has(l.id)) && (!q || norm(l.text).includes(q));
  const lines = [...S.items.values()].filter((l) => l.kind === 'line' && l.task && !l.deleted && S.items.get(l.parent_id)?.deleted === 0 && match(l));
  const titleOf = new Map();
  const tOf = (id) => { if (!titleOf.has(id)) titleOf.set(id, noteInfo(S.items.get(id)).title); return titleOf.get(id); };
  const row = (l, from) => `<div class="trow${l.done ? ' gone' : ''}"><button class="chk${l.done ? ' done' : ''}" data-t="${l.id}" aria-label="Hecha"></button>
      <span class="tx">${esc(l.text) || '&nbsp;'}${from ? `<span class="from">${esc(tOf(l.parent_id))}</span>` : ''}</span>${l.remind_at ? remChip(l) : ''}</div>`;
  const timed = lines.filter((l) => l.remind_at).sort((a, b) => a.remind_at - b.remind_at);
  const rest = lines.filter((l) => !l.remind_at);
  const groups = new Map();
  for (const l of rest) { if (!groups.has(l.parent_id)) groups.set(l.parent_id, []); groups.get(l.parent_id).push(l); }
  let h = '';
  if (timed.length) h += `<div class="tgroup"><div class="gt">Con aviso</div>${timed.map((l) => row(l, true)).join('')}</div>`;
  const gs = [...groups.entries()].map(([nid, ls]) => ({ nid, ls: ls.sort(byPos), mod: noteInfo(S.items.get(nid)).mod })).sort((a, b) => b.mod - a.mod);
  for (const g of gs) h += `<div class="tgroup"><button class="gt" data-n="${g.nid}">${esc(tOf(g.nid))}</button>${g.ls.map((l) => row(l, false)).join('')}</div>`;
  $('#notes').innerHTML = h || `<div class="nores">${q ? 'Ningún resultado' : 'Ninguna tarea pendiente'}</div>`;
  const c = lines.filter((l) => !l.done).length;
  const count = c === 1 ? '1 tarea' : `${c} tareas`;
  $('#listCount').textContent = count; $('#countFoot').textContent = count;
}

/* ---------- Editor ---------- */
const linesEl = $('#lines');
let lastLine = null; // última línea con el foco, para los botones de la barra
linesEl.addEventListener('focusin', (e) => { const el = e.target.closest('.line'); if (el) lastLine = el.dataset.id; });
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
function makeLine(id) {
  const el = document.createElement('div');
  el.className = 'line'; el.dataset.id = id;
  el.innerHTML = '<button class="chk" tabindex="-1" aria-label="Marcar"></button><div class="lc"><textarea rows="1" spellcheck="true"></textarea><button class="rem" tabindex="-1"></button></div>';
  return el;
}
function renderEditor(fresh) {
  const n = S.items.get(S.view.note);
  const ed = $('#editor');
  if (!n || n.deleted === 2) { ed.classList.add('none'); linesEl.innerHTML = ''; return; }
  ed.classList.remove('none');
  const ro = n.deleted === 1;
  $('#trashBar').hidden = !ro;
  document.querySelectorAll('[data-act="pin"]').forEach((b) => b.classList.toggle('on', !!n.pinned));
  $('#moveSel').value = n.parent_id || '';
  if (fresh) { linesEl.innerHTML = ''; lastLine = null; }
  let ls = linesOf(n.id);
  if (!ls.length && !ro) { create('line', { parent_id: n.id, pos: between('', '') }); ls = linesOf(n.id); }
  const info = noteInfo(n);
  $('#noteDate').textContent = new Date(info.mod).toLocaleString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' a las');
  const have = new Map([...linesEl.children].map((el) => [el.dataset.id, el]));
  let prev = null;
  ls.forEach((l, i) => {
    let el = have.get(l.id);
    if (!el) el = makeLine(l.id); else have.delete(l.id);
    el.className = 'line' + (i === 0 ? ' title' : '') + (l.task ? ' task' : '') + (l.done ? ' done' : '') + (l.remind_at ? ' hasrem' : '');
    const ta = el.querySelector('textarea');
    ta.readOnly = ro;
    ta.placeholder = i === 0 && ls.length === 1 ? 'Título' : '';
    if (ta.value !== l.text) {
      const focused = document.activeElement === ta, s = ta.selectionStart;
      ta.value = l.text;
      if (focused) ta.setSelectionRange(Math.min(s, l.text.length), Math.min(s, l.text.length));
      requestAnimationFrame(() => autosize(ta));
    }
    const rem = el.querySelector('.rem');
    const remHtml = l.remind_at ? remChip(l).replace(/^<span[^>]*>|<\/span>$/g, '') : '';
    if (rem.innerHTML !== remHtml) rem.innerHTML = remHtml;
    rem.classList.toggle('late', !!l.remind_at && !l.done && l.remind_at < Date.now());
    const want = prev ? prev.nextSibling : linesEl.firstChild;
    if (want !== el) linesEl.insertBefore(el, want);
    prev = el;
  });
  have.forEach((el) => el.remove());
  if (fresh) requestAnimationFrame(() => linesEl.querySelectorAll('textarea').forEach(autosize));
}
// Síncrono a propósito: si se escribe rápido, la siguiente tecla ya tiene que caer en la línea nueva
function focusLine(id, at) {
  const el = linesEl.querySelector(`[data-id="${id}"] textarea`);
  if (!el) return;
  el.focus();
  const p = at === Infinity ? el.value.length : Math.min(at, el.value.length);
  el.setSelectionRange(p, p);
}
function ctxOf(lineId) {
  const ls = linesOf(S.view.note), i = ls.findIndex((l) => l.id === lineId);
  if (i < 0) return null;
  const el = linesEl.querySelector(`[data-id="${lineId}"]`);
  return { el, ta: el && el.querySelector('textarea'), ls, i, line: ls[i] };
}
const ctx = (target) => { const el = target.closest('.line'); return el ? ctxOf(el.dataset.id) : null; };
const TASK_RE = /^\s*(?:[-*]\s*)?\[( |x|X)?\]\s|^\s*[☐☑✓✔]\s/;

function toggleTask(c) {
  if (!c || c.i === 0) return;
  update(c.line, { task: !c.line.task, done: false });
  renderEditor(false); renderSide();
}
function toggleDone(c) {
  const done = !c.line.done;
  update(c.line, { done });
  autoSort(c.ls, c.i, done);
  renderEditor(false); renderSide();
}
// Como "ordenar tareas automáticamente" en Notas: la hecha baja al final de su bloque de tareas.
function autoSort(ls, i, done) {
  let a = i, b = i;
  while (a > 1 && ls[a - 1].task) a--;
  while (b + 1 < ls.length && ls[b + 1].task) b++;
  const me = ls[i];
  if (done) {
    if (b === i) return;
    update(me, { pos: between(ls[b].pos, ls[b + 1] ? ls[b + 1].pos : '') });
  } else {
    const firstDone = ls.slice(a, i).findIndex((l) => l.done);
    if (firstDone < 0) return;
    const k = a + firstDone;
    update(me, { pos: between(k > 0 ? ls[k - 1].pos : '', ls[k].pos) });
  }
}
// La línea activa para los botones de la barra; si no hay, una tarea nueva al final
function activeLine(makeTask) {
  const c = lastLine && ctxOf(lastLine);
  if (c) return c;
  const ls = linesOf(S.view.note), last = ls[ls.length - 1];
  const l = last && ls.length > 1 && !last.text ? last : create('line', { parent_id: S.view.note, pos: between(last ? last.pos : '', '') });
  if (makeTask) update(l, { task: true });
  renderEditor(false);
  return ctxOf(l.id);
}

linesEl.addEventListener('input', (e) => {
  const c = ctx(e.target); if (!c) return;
  let v = c.ta.value;
  const m = c.i > 0 && !c.line.task && v.match(TASK_RE);
  if (m) {
    v = v.slice(m[0].length);
    update(c.line, { task: true, done: /x/i.test(m[1] || ''), text: v });
    c.ta.value = v; c.ta.setSelectionRange(0, 0);
    renderEditor(false);
  } else update(c.line, { text: v });
  autosize(c.ta);
  renderListSoon();
});
let listTimer = null;
function renderListSoon() { clearTimeout(listTimer); listTimer = setTimeout(renderList, 300); }

linesEl.addEventListener('keydown', (e) => {
  const c = ctx(e.target); if (!c || e.isComposing) return;
  const { ta, ls, i, line } = c;
  const s = ta.selectionStart, en = ta.selectionEnd, mod = isMac ? e.metaKey : e.ctrlKey;
  const n = S.items.get(S.view.note);
  if (n.deleted) return;

  if (mod && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleTask(c); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); if (line.task) toggleDone(c); return; }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (line.task && !ta.value) { update(line, { task: false, done: false }); renderEditor(false); return; }
    if (s === 0 && en === 0 && ta.value && i > 0) {
      create('line', { parent_id: n.id, pos: between(ls[i - 1].pos, line.pos), task: line.task });
      renderEditor(false); focusLine(line.id, 0); return;
    }
    const before = ta.value.slice(0, s), after = ta.value.slice(en);
    update(line, { text: before });
    const nl = create('line', { parent_id: n.id, pos: between(line.pos, ls[i + 1] ? ls[i + 1].pos : ''), text: after, task: i > 0 && line.task });
    ta.value = before; autosize(ta);
    renderEditor(false); focusLine(nl.id, 0); renderListSoon();
    return;
  }
  if (e.key === 'Backspace' && s === 0 && en === 0) {
    if (line.task) { e.preventDefault(); update(line, { task: false, done: false }); renderEditor(false); return; }
    if (i === 0) return;
    e.preventDefault();
    const p = ls[i - 1], at = p.text.length;
    update(p, { text: p.text + line.text, remind_at: p.remind_at || line.remind_at });
    update(line, { deleted: 2, text: '', remind_at: null });
    renderEditor(false); focusLine(p.id, at); renderListSoon();
    return;
  }
  if (e.key === 'Delete' && s === ta.value.length && en === s && ls[i + 1]) {
    e.preventDefault();
    const nx = ls[i + 1];
    update(line, { text: line.text + nx.text, remind_at: line.remind_at || nx.remind_at });
    update(nx, { deleted: 2, text: '', remind_at: null });
    renderEditor(false); focusLine(line.id, s);
    return;
  }
  const oneRow = ta.scrollHeight <= parseFloat(getComputedStyle(ta).lineHeight) * 1.6 + 8;
  if (e.key === 'ArrowUp' && i > 0 && (s === 0 || oneRow) && !e.shiftKey) { e.preventDefault(); focusLine(ls[i - 1].id, s); }
  if (e.key === 'ArrowDown' && ls[i + 1] && (s === ta.value.length || oneRow) && !e.shiftKey) { e.preventDefault(); focusLine(ls[i + 1].id, s); }
});

linesEl.addEventListener('paste', (e) => {
  const c = ctx(e.target); if (!c) return;
  const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (!txt || !/\r?\n/.test(txt)) return;
  e.preventDefault();
  const n = S.items.get(S.view.note);
  const parts = txt.replace(/\r\n?/g, '\n').split('\n');
  const { ta, ls, i, line } = c;
  const before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionEnd);
  update(line, { text: before + parts[0] });
  let prevPos = line.pos, last = line;
  const nextPos = ls[i + 1] ? ls[i + 1].pos : '';
  for (let k = 1; k < parts.length; k++) {
    let t = parts[k], task = false, done = false;
    const m = t.match(TASK_RE);
    if (m) { task = true; done = /x/i.test(m[1] || ''); t = t.slice(m[0].length); }
    if (k === parts.length - 1) t += after;
    prevPos = between(prevPos, nextPos);
    last = create('line', { parent_id: n.id, pos: prevPos, text: t, task, done });
  }
  renderEditor(false); renderList();
  focusLine(last.id, last.text.length - after.length);
});

linesEl.addEventListener('click', (e) => {
  const n = S.items.get(S.view.note);
  if (e.target.closest('.chk')) { const c = ctx(e.target); if (c && !n.deleted) toggleDone(c); return; }
  if (e.target.closest('.rem')) { const c = ctx(e.target); if (c && !n.deleted) { lastLine = c.line.id; openMenu(e.target.closest('.rem')); } return; }
});
$('#scroller').addEventListener('click', (e) => {
  if (e.target.closest('.line')) return;
  const ls = linesOf(S.view.note), last = ls[ls.length - 1];
  if (last) focusLine(last.id, Infinity);
});
addEventListener('resize', () => linesEl.querySelectorAll('textarea').forEach(autosize));

/* ---------- Recordatorios ---------- */
const menu = $('#remindMenu'), veil = $('#veil'), picker = $('#picker');
let menuLine = null;
function openMenu(anchor) {
  const c = activeLine(true); if (!c) return;
  menuLine = c.line.id;
  const r = anchor.getBoundingClientRect();
  menu.hidden = false; veil.hidden = false;
  menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8) + 'px';
  const cur = c.line.remind_at || Date.now() + 3600e3;
  const d = new Date(cur - new Date(cur).getTimezoneOffset() * 6e4);
  picker.value = d.toISOString().slice(0, 16);
  menu.querySelector('[data-r="none"]').hidden = !c.line.remind_at;
}
function closeMenu() { menu.hidden = true; veil.hidden = true; }
function setRemind(ms) {
  const c = menuLine && ctxOf(menuLine);
  closeMenu();
  if (!c) return;
  update(c.line, ms ? { remind_at: ms, task: c.i > 0 ? true : c.line.task, done: false } : { remind_at: null });
  renderEditor(false); renderSide();
  focusLine(c.line.id, Infinity);
}
veil.addEventListener('click', closeMenu);
menu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  const now = new Date(), at = (days, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, 0).getTime();
  const r = b.dataset.r;
  if (r === 'later') setRemind(Math.ceil((Date.now() + 3600e3) / 3e5) * 3e5);
  if (r === 'evening') setRemind(now.getHours() < 18 ? at(0, 18) : at(1, 18));
  if (r === 'tomorrow') setRemind(at(1, 9));
  if (r === 'monday') setRemind(at(((8 - now.getDay()) % 7) || 7, 9));
  if (r === 'none') setRemind(null);
});
picker.addEventListener('change', () => { if (picker.value) setRemind(new Date(picker.value).getTime()); });
menu.querySelector('.pick').addEventListener('click', () => { try { picker.showPicker(); } catch (_) { picker.focus(); } });

/* ---------- Botones ---------- */
const actions = {
  newNote,
  newFolder() { go('side'); $('#newFolderForm').hidden = false; $('#newFolderInput').focus(); },
  task() { const c = activeLine(false); if (!c) return; if (c.i === 0) { activeLine(true); return; } toggleTask(c); focusLine(c.line.id, Infinity); },
  remind(btn) { if (S.items.get(S.view.note)?.deleted === 0) openMenu(btn); },
  pin() { const n = S.items.get(S.view.note); update(n, { pinned: !n.pinned }); render(); },
  delete() {
    const n = S.items.get(S.view.note); if (!n || n.deleted === 1) return;
    if (isEmptyNote(n)) purgeNote(n); else update(n, { deleted: 1, pinned: false });
    S.view.note = null; render();
    if (!wide()) history.back();
  },
};
document.querySelectorAll('[data-act]').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault()); // no robar el foco a la línea
  b.addEventListener('click', () => actions[b.dataset.act](b));
});

$('#folders').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) selectFolder(b.dataset.f); });
$('#notes').addEventListener('click', (e) => {
  const t = e.target.closest('[data-t]');
  if (t) {
    const l = S.items.get(t.dataset.t);
    update(l, { done: !l.done });
    if (l.done) { recentlyDone.add(l.id); setTimeout(() => { recentlyDone.delete(l.id); renderList(); }, 1500); }
    renderList(); renderSide();
    return;
  }
  const b = e.target.closest('[data-n]'); if (b) openNote(b.dataset.n);
});
$('#search').addEventListener('input', (e) => { S.view.q = e.target.value; renderList(); });
$('#moveSel').addEventListener('change', (e) => { const n = S.items.get(S.view.note); update(n, { parent_id: e.target.value || null }); render(); });
$('#restoreBtn').addEventListener('click', () => { const n = S.items.get(S.view.note); update(n, { deleted: 0 }); render(); renderEditor(true); });
$('#purgeBtn').addEventListener('click', () => {
  const n = S.items.get(S.view.note);
  if (!confirm('¿Borrar esta nota del todo? No se puede deshacer.')) return;
  purgeNote(n); render(); if (!wide()) history.back();
});
$('#newFolderForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#newFolderInput').value.trim();
  $('#newFolderForm').hidden = true; $('#newFolderInput').value = '';
  if (name) { const f = create('folder', { text: name }); selectFolder(f.id); }
});
$('#newFolderInput').addEventListener('blur', () => setTimeout(() => { $('#newFolderForm').hidden = true; }, 150));
$('#listTitle').addEventListener('change', (e) => {
  const f = S.items.get(S.view.folder);
  if (f && f.kind === 'folder' && e.target.value.trim()) { update(f, { text: e.target.value.trim() }); render(); }
});
$('#listTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#folderDelBtn').addEventListener('click', () => {
  const f = S.items.get(S.view.folder);
  if (!f || !confirm(`¿Eliminar la carpeta «${f.text}»? Sus notas pasan a «Todas las notas».`)) return;
  for (const n of notes()) if (n.parent_id === f.id) update(n, { parent_id: null });
  update(f, { deleted: 2 });
  selectFolder('all');
});
$('#quickTask').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#quickTaskInput').value.trim(); if (!text) return;
  $('#quickTaskInput').value = '';
  // Las tareas rápidas van a una nota "Tareas" (la crea si no existe)
  let inbox = notes().find((n) => n.deleted === 0 && noteInfo(n).title === 'Tareas');
  if (!inbox) { inbox = create('note', {}); create('line', { parent_id: inbox.id, pos: between('', ''), text: 'Tareas' }); }
  const ls = linesOf(inbox.id);
  const firstDone = ls.findIndex((l, k) => k > 0 && l.task && l.done);
  const pos = firstDone > 0 ? between(ls[firstDone - 1].pos, ls[firstDone].pos) : between(ls[ls.length - 1].pos, '');
  create('line', { parent_id: inbox.id, pos, text, task: true });
  renderList(); renderSide();
});
$('#exportBtn').addEventListener('click', () => {
  let md = '';
  for (const n of notes().filter((n) => n.deleted === 0)) {
    md += linesOf(n.id).map((l, i) => (i === 0 ? '# ' : '') + (l.task ? `- [${l.done ? 'x' : ' '}] ` : '') + l.text +
      (l.remind_at ? ` (aviso: ${new Date(l.remind_at).toLocaleString('es-ES')})` : '')).join('\n') + '\n\n---\n\n';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `notas-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
});
document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') closeMenu();
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); go('list'); $('#search').focus(); }
});

/* ---------- Acceso ---------- */
async function authSubmit(signup) {
  const email = $('#authEmail').value.trim(), password = $('#authPass').value;
  const msg = $('#authMsg'); msg.textContent = signup ? 'Creando cuenta…' : 'Entrando…';
  const { data, error } = signup ? await S.sb.auth.signUp({ email, password }) : await S.sb.auth.signInWithPassword({ email, password });
  if (error) { msg.textContent = error.message === 'Invalid login credentials' ? 'Email o contraseña incorrectos' : error.message; return; }
  if (signup && !data.session) { msg.textContent = 'Cuenta creada. Confírmala desde tu email y entra.'; return; }
  msg.textContent = '';
}
$('#authForm').addEventListener('submit', (e) => { e.preventDefault(); authSubmit(false); });
$('#signupBtn').addEventListener('click', () => { if ($('#authForm').reportValidity()) authSubmit(true); });
$('#logoutBtn').addEventListener('click', async () => {
  if (S.outbox.size && !confirm('Hay cambios sin subir. Si sales, se pierden. ¿Salir igualmente?')) return;
  await S.sb.auth.signOut();
  await store.clear(); location.reload();
});

/* ---------- Arranque ---------- */
async function boot() {
  await store.open();
  const meta = await store.getMeta();
  if (meta) S.meta = meta; else S.meta.device = crypto.randomUUID().slice(0, 8);
  S.outbox = new Set(S.meta.outbox || []);
  S.gcal = new Set(S.meta.gcal || []);
  for (const it of await store.all()) S.items.set(it.id, it);
  // Eliminadas hace más de 30 días: fuera, como en Notas
  const limit = Date.now() - 30 * DAY;
  for (const n of notes()) if (n.deleted === 1 && n.updated_at < limit) purgeNote(n);

  app.dataset.pane = 'list';
  history.replaceState({ pane: 'list' }, '');
  render();

  setStatus(HAS_CLOUD ? 'busy' : 'off', HAS_CLOUD ? 'Conectando…' : 'Solo en este dispositivo');
  if (HAS_CLOUD) {
    S.sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await S.sb.auth.getSession();
    S.session = data.session;
    const showAuth = () => { $('#auth').hidden = !!S.session; $('#logoutBtn').hidden = !S.session; renderGcal(); };
    S.sb.auth.onAuthStateChange((_ev, session) => {
      const was = S.session && S.session.user.id;
      S.session = session; showAuth();
      if (session && session.user.id !== was) { listenRealtime(); syncSoon(0); }
    });
    showAuth();
    if (S.session) { listenRealtime(); syncSoon(0); }
  }
  addEventListener('online', () => syncSoon(0));
  addEventListener('offline', () => setStatus('off', 'Sin conexión: se guarda aquí y se sube al volver'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(0); else persist(); });
  setInterval(() => { syncSoon(0); if (S.view.folder === 'tasks') renderList(); }, 30000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
}
boot();
