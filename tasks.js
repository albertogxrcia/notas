'use strict';
/*
 * Tareas: tablero de listas (la estructura de Google Tasks) con el aspecto de Recordatorios de Apple.
 *  - Una lista es un item kind='list'; una tarea, kind='task' con parent_id = lista.
 *  - pinned = destacada · remind_at = fecha (si allday, a las 9:00 para que Calendar avise)
 *  - repeat = JSON { n, unit, end: 'never'|'on'|'after', until, count, done }
 *  - Al completar una tarea que se repite, nace la siguiente con su nueva fecha.
 */
const LIST_COLORS = ['#007aff', '#ff9500', '#34c759', '#ff3b30', '#af52de', '#ff2d55', '#a2845e', '#5ac8fa'];
const DEFAULT_LIST = 'Mis tareas';
const UNITS = { day: ['día', 'días'], week: ['semana', 'semanas'], month: ['mes', 'meses'], year: ['año', 'años'] };
const T = { editing: null, openDone: new Set(), current: null };

/* ---------- Datos ---------- */
// La lista por defecto usa el id del usuario: así dos dispositivos nunca crean dos distintas
const defaultListId = () => (S.session && S.session.user.id) || '00000000-0000-4000-8000-00000000a11a';
function taskLists() {
  const ls = [...S.items.values()].filter((i) => i.kind === 'list' && !i.deleted).sort(byPos);
  if (!ls.some((l) => l.id === defaultListId())) ls.unshift({ id: defaultListId(), kind: 'list', text: DEFAULT_LIST, color: LIST_COLORS[0], pos: '', virtual: true });
  return ls;
}
function ensureList(id) {
  const have = S.items.get(id);
  if (have) return have;
  const it = { id, kind: 'list', parent_id: null, pos: '', text: DEFAULT_LIST, task: false, done: false, pinned: false, deleted: 0, remind_at: null, details: '', repeat: null, allday: false, color: LIST_COLORS[0] };
  touch(it);
  return it;
}
const tasksOf = (listId) => kids(listId).filter((t) => t.kind === 'task' && !t.deleted);
const sortMode = (id) => { try { return localStorage.getItem('notas-orden-' + id) || 'mine'; } catch (_) { return 'mine'; } };
function openTasks(listId) {
  const ts = tasksOf(listId).filter((t) => !t.done).sort(byPos);
  if (sortMode(listId) === 'date') ts.sort((a, b) => (a.remind_at || Infinity) - (b.remind_at || Infinity));
  return ts;
}
const doneTasks = (listId) => tasksOf(listId).filter((t) => t.done).sort((a, b) => b.updated_at - a.updated_at);

/* ---------- Fechas ---------- */
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTimeInput = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function relPast(days) {
  if (days < 7) return `hace ${days} días`;
  if (days < 60) { const w = Math.round(days / 7); return w === 1 ? 'hace 1 semana' : `hace ${w} semanas`; }
  if (days < 365) return `hace ${Math.round(days / 30)} meses`;
  const y = Math.round(days / 365);
  return y === 1 ? 'hace 1 año' : `hace ${y} años`;
}
function dueInfo(t) {
  if (!t.remind_at) return null;
  const d = new Date(t.remind_at), today = startOfDay(new Date()), day = startOfDay(d);
  const diff = Math.round((day - today) / DAY);
  const late = !t.done && (t.allday ? day < today : t.remind_at < Date.now());
  const hm = t.allday ? '' : ', ' + d.toLocaleTimeString('es-ES', { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return { label: 'Hoy' + hm, late };
  if (diff === 1) return { label: 'Mañana' + hm, late };
  if (diff === -1) return { label: 'Ayer' + hm, late };
  if (diff < -1) return { label: (late ? 'Venció ' : 'Fue ') + relPast(-diff), late };
  if (diff < 7) { const w = d.toLocaleDateString('es-ES', { weekday: 'long' }); return { label: w[0].toUpperCase() + w.slice(1) + hm, late }; }
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return { label: d.toLocaleDateString('es-ES', opts) + hm, late };
}
function parseRepeat(t) { try { return t.repeat ? JSON.parse(t.repeat) : null; } catch (_) { return null; } }
function repeatLabel(t) {
  const r = parseRepeat(t);
  if (!r) return '';
  return r.n === 1 ? `Cada ${UNITS[r.unit][0]}` : `Cada ${r.n} ${UNITS[r.unit][1]}`;
}
function addInterval(ms, r) {
  const d = new Date(ms);
  if (r.unit === 'day') d.setDate(d.getDate() + r.n);
  if (r.unit === 'week') d.setDate(d.getDate() + 7 * r.n);
  if (r.unit === 'month' || r.unit === 'year') { // el 31 de un mes corto cae en su último día
    const day = d.getDate();
    d.setDate(1);
    if (r.unit === 'month') d.setMonth(d.getMonth() + r.n); else d.setFullYear(d.getFullYear() + r.n);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return d.getTime();
}
function spawnNext(t) {
  const r = parseRepeat(t);
  if (!r) return;
  let next = addInterval(t.remind_at || Date.now(), r);
  const count = (r.done || 0) + 1;
  // Si llevaba retraso, la siguiente cae en el futuro y no en otra fecha ya vencida
  while (next < startOfDay(new Date())) next = addInterval(next, r);
  if (r.end === 'after' && count >= r.count) return;
  if (r.end === 'on' && r.until && startOfDay(new Date(next)) > new Date(r.until + 'T00:00').getTime()) return;
  create('task', { parent_id: t.parent_id, pos: t.pos, text: t.text, details: t.details, pinned: t.pinned, remind_at: next, allday: t.allday, repeat: JSON.stringify({ ...r, done: count }) });
}

/* ---------- Pintado ---------- */
function taskRow(t) {
  if (T.editing === t.id) return editRow(t);
  const due = dueInfo(t), rep = repeatLabel(t);
  const meta = (due ? `<span class="tmeta${due.late ? ' late' : ''}">${icon('clock')}${esc(due.label)}</span>` : '') + (rep ? `<span class="tmeta">${icon('repeat')}${esc(rep)}</span>` : '');
  return `<div class="task${t.done ? ' done' : ''}" data-task="${t.id}">
    <button class="tchk" data-tdone="${t.id}" aria-label="${t.done ? 'Marcar pendiente' : 'Completar'}"></button>
    <div class="tbody"><div class="ttitle">${esc(t.text) || '&nbsp;'}</div>${t.details ? `<div class="tdet">${esc(t.details)}</div>` : ''}${meta ? `<div class="tmetas">${meta}</div>` : ''}</div>
    <button class="tflag${t.pinned ? ' on' : ''}" data-tflag="${t.id}" aria-label="Destacar">${icon('flag')}</button>
  </div>`;
}
function editRow(t) {
  const due = dueInfo(t), rep = repeatLabel(t), today = startOfDay(new Date());
  const isDay = (o) => !!t.remind_at && startOfDay(new Date(t.remind_at)) === new Date(new Date(today).setDate(new Date(today).getDate() + o)).getTime();
  const lists = taskLists().map((l) => `<option value="${l.id}"${l.id === t.parent_id ? ' selected' : ''}>${esc(l.text)}</option>`).join('');
  return `<div class="task editing" data-task="${t.id}">
    <button class="tchk" data-tdone="${t.id}" aria-label="Completar"></button>
    <div class="tbody">
      <textarea class="tin ttitlein" data-field="title" rows="1" placeholder="Título">${esc(t.text)}</textarea>
      <div class="tdetwrap">${icon('details')}<textarea class="tin tdetin" data-field="details" rows="1" placeholder="Detalles">${esc(t.details || '')}</textarea></div>
      <div class="tbtns">
        <button class="tbtn${isDay(0) ? ' on' : ''}" data-tq="today">Hoy</button>
        <button class="tbtn${isDay(1) ? ' on' : ''}" data-tq="tomorrow">Mañana</button>
        <button class="tbtn${due && !isDay(0) && !isDay(1) ? ' on' : ''}${due && due.late ? ' late' : ''}" data-tq="pick" title="Fecha y hora">${icon('clock')}${due && (!isDay(0) && !isDay(1) || !t.allday) ? esc(due.label) : ''}</button>
        <button class="tbtn${rep ? ' on' : ''}" data-tq="repeat" title="Repetir">${icon('repeat')}${esc(rep)}</button>
      </div>
      <div class="tbtns tbtns2">
        <label class="tmove">${icon('move')}<select data-tq-move="${t.id}" aria-label="Mover a lista">${lists}</select></label>
        <span class="spacer"></span>
        <button class="tico${t.pinned ? ' flagged' : ''}" data-tflag="${t.id}" title="Destacar">${icon('flag')}</button>
        <button class="tico" data-tq="delete" title="Eliminar">${icon('trash')}</button>
      </div>
    </div>
  </div>`;
}
function listColumn(l, q) {
  const color = l.color || LIST_COLORS[0];
  const match = (t) => !q || norm(t.text + ' ' + (t.details || '')).includes(q);
  const open = openTasks(l.id).filter((t) => match(t) || t.id === T.editing), done = doneTasks(l.id).filter(match);
  const showDone = T.openDone.has(l.id) || !!q;
  return `<section class="tcol${T.current === l.id ? ' cur' : ''}" data-list="${l.id}" style="--lc:${esc(color)}">
    <header class="thead">
      <input class="tname" data-field="listname" value="${esc(l.text)}" aria-label="Nombre de la lista">
      <span class="tcount">${open.length || ''}</span>
      <button class="tico" data-lmenu="${l.id}" aria-label="Opciones de la lista">${icon('more')}</button>
    </header>
    <button class="tadd" data-add="${l.id}">${icon('plus-circle')}Añadir una tarea</button>
    <div class="ttasks">${open.map(taskRow).join('')}</div>
    ${done.length ? `<button class="tdonehead${showDone ? ' open' : ''}" data-compl="${l.id}">${icon('chev')}Completadas (${done.length})</button>
    ${showDone ? `<div class="ttasks">${done.map(taskRow).join('')}</div>` : ''}` : ''}
  </section>`;
}
function notesColumn(q) {
  const lines = [...S.items.values()].filter((l) => l.kind === 'line' && l.task && !l.deleted && S.items.get(l.parent_id)?.deleted === 0 && (!l.done || recentlyDone.has(l.id)) && (!q || norm(l.text).includes(q)));
  if (!lines.length) return '';
  const groups = new Map();
  for (const l of lines) { if (!groups.has(l.parent_id)) groups.set(l.parent_id, []); groups.get(l.parent_id).push(l); }
  const body = [...groups.entries()].map(([nid, ls]) => `<button class="tnotehead" data-opennote="${nid}">${icon('notes')}${esc(noteInfo(S.items.get(nid)).title)}</button>` +
    ls.sort(byPos).map((l) => { const due = dueInfo(l); return `<div class="task${l.done ? ' done' : ''}"><button class="tchk" data-t="${l.id}" aria-label="Completar"></button><div class="tbody"><div class="ttitle">${esc(l.text) || '&nbsp;'}</div>${due ? `<div class="tmetas"><span class="tmeta${due.late ? ' late' : ''}">${icon('clock')}${esc(due.label)}</span></div>` : ''}</div></div>`; }).join('')).join('');
  return `<section class="tcol${T.current === 'notas' ? ' cur' : ''}" data-list="notas" style="--lc:var(--tint)">
    <header class="thead"><span class="tname fixed">En tus notas</span><span class="tcount">${lines.filter((l) => !l.done).length}</span></header>
    <div class="ttasks">${body}</div></section>`;
}
function renderBoard(q) {
  const root = $('#notes');
  const prev = root.querySelector('.tboard'), scrollX = prev ? prev.scrollLeft : 0, scrolls = {};
  root.querySelectorAll('.tcol').forEach((c) => { scrolls[c.dataset.list] = c.scrollTop; });
  const ae = document.activeElement;
  let keep = null;
  if (ae && ae.dataset && ae.dataset.field && root.contains(ae)) {
    keep = { task: ae.closest('[data-task]')?.dataset.task, list: ae.closest('[data-list]')?.dataset.list, field: ae.dataset.field, s: ae.selectionStart, e: ae.selectionEnd };
  }
  const lists = taskLists();
  const notesCol = notesColumn(q);
  const ids = lists.map((l) => l.id).concat(notesCol ? ['notas'] : []);
  if (!ids.includes(T.current)) T.current = lists[0].id;
  // notesColumn se pinta con T.current ya resuelto
  const notesHtml = notesColumn(q);
  const chips = lists.map((l) => `<button class="tchip${T.current === l.id ? ' on' : ''}" data-lchip="${l.id}" style="--lc:${esc(l.color || LIST_COLORS[0])}">${esc(l.text)}</button>`).join('') +
    (notesHtml ? `<button class="tchip${T.current === 'notas' ? ' on' : ''}" data-lchip="notas" style="--lc:var(--tint)">En tus notas</button>` : '') +
    '<button class="tchip add" data-newlist="1" aria-label="Nueva lista">+</button>';
  root.innerHTML = `<div class="tchips">${chips}</div><div class="tboard">${lists.map((l) => listColumn(l, q)).join('')}${notesHtml}
    <button class="tnewlist" data-newlist="1">${icon('plus-circle')}Nueva lista</button></div>`;
  const board = root.querySelector('.tboard');
  board.scrollLeft = scrollX;
  root.querySelectorAll('.tcol').forEach((c) => { if (scrolls[c.dataset.list]) c.scrollTop = scrolls[c.dataset.list]; });
  root.querySelectorAll('textarea.tin').forEach(autosize);
  if (keep) {
    const sel = keep.task ? `[data-task="${keep.task}"] [data-field="${keep.field}"]` : `[data-list="${keep.list}"] [data-field="${keep.field}"]`;
    const el = root.querySelector(sel);
    if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (_) {} }
  }
  const total = openTaskLines().length;
  const label = total === 1 ? '1 tarea' : `${total} tareas`;
  $('#listCount').textContent = label; $('#countFoot').textContent = label;
}
const repaint = () => { renderList(); renderSide(); };
function focusTask(id) {
  const el = $('#notes').querySelector(`[data-task="${id}"] [data-field="title"]`);
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

/* ---------- Acciones ---------- */
function closeEdit() {
  const id = T.editing;
  T.editing = null;
  const t = S.items.get(id);
  if (t && !t.done && !t.text.trim() && !(t.details || '').trim() && !t.remind_at) update(t, { deleted: 2 }); // vacía: no se queda
}
function addTask(listId) {
  if (T.editing) closeEdit();
  const id = listId === 'notas' ? defaultListId() : listId;
  ensureList(id);
  T.current = id;
  const first = openTasks(id)[0];
  const t = create('task', { parent_id: id, pos: between('', first ? first.pos : '') });
  T.editing = t.id;
  repaint(); focusTask(t.id);
}
function toggleDoneTask(id) {
  const t = S.items.get(id);
  if (T.editing === id) T.editing = null;
  if (!t.done && t.repeat) { spawnNext(t); update(t, { done: true, repeat: null }); } else update(t, { done: !t.done });
  repaint();
}
function setDay(t, offset) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate() + offset;
  const target = new Date(y, m, d, 9, 0).getTime();
  if (t.remind_at && startOfDay(new Date(t.remind_at)) === startOfDay(new Date(target))) update(t, { remind_at: null, allday: false, repeat: null });
  else if (t.remind_at && !t.allday) { const c = new Date(t.remind_at); update(t, { remind_at: new Date(y, m, d, c.getHours(), c.getMinutes()).getTime() }); }
  else update(t, { remind_at: target, allday: true });
  repaint(); focusTask(t.id);
}
function renameList(id, name) { const l = ensureList(id); update(l, { text: name }); }
function newList() {
  const ls = taskLists(), last = ls[ls.length - 1];
  ensureList(defaultListId());
  const l = create('list', { text: 'Nueva lista', color: LIST_COLORS[ls.length % LIST_COLORS.length], pos: between(last.pos || 'V', '') });
  T.current = l.id;
  repaint();
  const input = $('#notes').querySelector(`[data-list="${l.id}"] .tname`);
  if (input) { input.scrollIntoView({ inline: 'nearest', block: 'nearest' }); input.focus(); input.select(); }
}

/* ---------- Hojas (fecha, repetir) y menú ---------- */
function openSheet(html) {
  closeSheet();
  const v = document.createElement('div');
  v.id = 'tveil'; v.innerHTML = `<div class="tsheet" role="dialog" aria-modal="true">${html}</div>`;
  v.addEventListener('mousedown', (e) => { if (e.target === v) closeSheet(); });
  document.body.appendChild(v);
  return v.firstChild;
}
function closeSheet() { const v = document.getElementById('tveil'); if (v) v.remove(); }
function closeListMenu() { const m = document.getElementById('tlmenu'); if (m) m.remove(); }

function dateSheet(t) {
  const base = t.remind_at || new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 9).getTime();
  const sh = openSheet(`<h3>Fecha y hora</h3>
    <label class="sfield">Fecha<input id="sDate" type="date" value="${toDateInput(base)}"></label>
    <label class="sfield">Hora <small>opcional</small><input id="sTime" type="time" value="${t.remind_at && !t.allday ? toTimeInput(t.remind_at) : ''}"></label>
    <div class="sbtns">${t.remind_at ? '<button class="sbtn danger" id="sClear">Quitar</button>' : ''}<span class="spacer"></span><button class="sbtn" id="sCancel">Cancelar</button><button class="sbtn primary" id="sOk">Hecho</button></div>`);
  sh.querySelector('#sCancel').onclick = closeSheet;
  if (t.remind_at) sh.querySelector('#sClear').onclick = () => { update(t, { remind_at: null, allday: false, repeat: null }); closeSheet(); repaint(); focusTask(t.id); };
  sh.querySelector('#sOk').onclick = () => {
    const date = sh.querySelector('#sDate').value, time = sh.querySelector('#sTime').value;
    if (!date) return;
    update(t, { remind_at: new Date(`${date}T${time || '09:00'}`).getTime(), allday: !time });
    closeSheet(); repaint(); focusTask(t.id);
  };
}

function repeatSheet(t) {
  const r = parseRepeat(t) || { n: 1, unit: 'day', end: 'never' };
  const base = t.remind_at || Date.now();
  const defUntil = toDateInput(addInterval(base, { n: 1, unit: 'month' }));
  const sh = openSheet(`<h3>Se repite cada</h3>
    <div class="srow"><input id="rN" type="number" min="1" max="999" value="${r.n}">
      <select id="rUnit">${Object.keys(UNITS).map((u) => `<option value="${u}"${u === r.unit ? ' selected' : ''}>${UNITS[u][r.n === 1 ? 0 : 1]}</option>`).join('')}</select></div>
    <label class="sfield">Hora <small>opcional</small><input id="rTime" type="time" value="${t.remind_at && !t.allday ? toTimeInput(t.remind_at) : ''}"></label>
    <h4>Empieza</h4><input id="rStart" class="sinput" type="date" value="${toDateInput(base)}">
    <h4>Termina</h4>
    <label class="sradio"><input type="radio" name="rEnd" value="never"${r.end === 'never' ? ' checked' : ''}>Nunca</label>
    <label class="sradio"><input type="radio" name="rEnd" value="on"${r.end === 'on' ? ' checked' : ''}>El<input id="rUntil" class="sinput" type="date" value="${r.until || defUntil}"></label>
    <label class="sradio"><input type="radio" name="rEnd" value="after"${r.end === 'after' ? ' checked' : ''}>Después de<input id="rCount" class="sinput short" type="number" min="1" max="999" value="${r.count || 30}">repeticiones</label>
    <div class="sbtns">${t.repeat ? '<button class="sbtn danger" id="rClear">No repetir</button>' : ''}<span class="spacer"></span><button class="sbtn" id="rCancel">Cancelar</button><button class="sbtn primary" id="rOk">Hecho</button></div>`);
  const unit = sh.querySelector('#rUnit'), n = sh.querySelector('#rN');
  n.oninput = () => { const pl = Number(n.value) === 1 ? 0 : 1; [...unit.options].forEach((o) => { o.textContent = UNITS[o.value][pl]; }); };
  const syncEnd = () => {
    const end = sh.querySelector('input[name="rEnd"]:checked').value;
    sh.querySelector('#rUntil').disabled = end !== 'on';
    sh.querySelector('#rCount').disabled = end !== 'after';
  };
  sh.querySelectorAll('input[name="rEnd"]').forEach((x) => { x.onchange = syncEnd; });
  syncEnd();
  sh.querySelector('#rCancel').onclick = closeSheet;
  if (t.repeat) sh.querySelector('#rClear').onclick = () => { update(t, { repeat: null }); closeSheet(); repaint(); focusTask(t.id); };
  sh.querySelector('#rOk').onclick = () => {
    const start = sh.querySelector('#rStart').value, time = sh.querySelector('#rTime').value;
    if (!start) return;
    const end = sh.querySelector('input[name="rEnd"]:checked').value;
    const rule = { n: Math.max(1, parseInt(n.value, 10) || 1), unit: unit.value, end, done: r.done || 0 };
    if (end === 'on') rule.until = sh.querySelector('#rUntil').value;
    if (end === 'after') rule.count = Math.max(1, parseInt(sh.querySelector('#rCount').value, 10) || 1);
    update(t, { repeat: JSON.stringify(rule), remind_at: new Date(`${start}T${time || '09:00'}`).getTime(), allday: !time });
    closeSheet(); repaint(); focusTask(t.id);
  };
}

function listMenu(id, anchor) {
  closeListMenu();
  const l = taskLists().find((x) => x.id === id);
  const mode = sortMode(id), hasDone = doneTasks(id).length > 0, isDefault = id === defaultListId();
  const m = document.createElement('div');
  m.id = 'tlmenu'; m.className = 'menu';
  m.innerHTML = `<div class="menu-h">Ordenar</div>
    <button data-m="mine">${mode === 'mine' ? '✓ ' : ''}Mi orden</button>
    <button data-m="date">${mode === 'date' ? '✓ ' : ''}Por fecha</button>
    <div class="menu-h">Color</div>
    <div class="tcolors">${LIST_COLORS.map((c) => `<button class="tcolor${(l.color || LIST_COLORS[0]) === c ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color"></button>`).join('')}</div>
    <div class="menu-sep"></div>
    <button data-m="rename">Cambiar nombre</button>
    ${hasDone ? '<button data-m="clear">Eliminar completadas</button>' : ''}
    ${isDefault ? '' : '<button data-m="delete" class="danger">Eliminar lista</button>'}`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
  m.addEventListener('click', (e) => {
    const c = e.target.closest('[data-color]');
    if (c) { update(ensureList(id), { color: c.dataset.color }); closeListMenu(); repaint(); return; }
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const a = b.dataset.m;
    closeListMenu();
    if (a === 'mine' || a === 'date') { try { localStorage.setItem('notas-orden-' + id, a); } catch (_) {} repaint(); }
    if (a === 'rename') { const i = $('#notes').querySelector(`[data-list="${id}"] .tname`); if (i) { i.focus(); i.select(); } }
    if (a === 'clear' && confirm(`¿Eliminar las ${doneTasks(id).length} tareas completadas de «${l.text}»?`)) { doneTasks(id).forEach((t) => update(t, { deleted: 2 })); repaint(); }
    if (a === 'delete' && confirm(`¿Eliminar la lista «${l.text}» y todas sus tareas?`)) {
      tasksOf(id).forEach((t) => update(t, { deleted: 2 }));
      update(S.items.get(id), { deleted: 2 });
      T.current = null; repaint();
    }
  });
}

/* ---------- Eventos ---------- */
const boardEl = $('#notes');
const inBoard = () => S.view.folder === 'tasks';
boardEl.addEventListener('click', (e) => {
  if (!inBoard()) return;
  const row = e.target.closest('[data-task]');
  const q = (s) => e.target.closest(s);
  let b;
  if ((b = q('[data-tdone]'))) { toggleDoneTask(b.dataset.tdone); return; }
  if ((b = q('[data-tflag]'))) { const t = S.items.get(b.dataset.tflag); update(t, { pinned: !t.pinned }); repaint(); if (T.editing === t.id) focusTask(t.id); return; }
  if (q('[data-t]')) return; // tarea dentro de una nota: la marca app.js
  if ((b = q('[data-tq]'))) {
    const t = S.items.get(T.editing);
    if (!t) return;
    const a = b.dataset.tq;
    if (a === 'today') setDay(t, 0);
    if (a === 'tomorrow') setDay(t, 1);
    if (a === 'pick') dateSheet(t);
    if (a === 'repeat') repeatSheet(t);
    if (a === 'delete') { T.editing = null; update(t, { deleted: 2 }); repaint(); }
    return;
  }
  if (row && row.dataset.task === T.editing) return; // clic dentro de la que se edita
  if (q('.tmove')) return;
  if (T.editing) { closeEdit(); }
  if ((b = q('[data-add]'))) { addTask(b.dataset.add); return; }
  if ((b = q('[data-lmenu]'))) { listMenu(b.dataset.lmenu, b); renderList(); return; }
  if ((b = q('[data-compl]'))) { const id = b.dataset.compl; if (T.openDone.has(id)) T.openDone.delete(id); else T.openDone.add(id); repaint(); return; }
  if (q('[data-newlist]')) { newList(); return; }
  if ((b = q('[data-lchip]'))) { T.current = b.dataset.lchip; repaint(); return; }
  if ((b = q('[data-opennote]'))) { const id = b.dataset.opennote; selectFolder('all'); openNote(id); return; }
  if (row) { T.editing = row.dataset.task; repaint(); focusTask(row.dataset.task); return; }
  repaint();
});
boardEl.addEventListener('input', (e) => {
  if (!inBoard()) return;
  const f = e.target.dataset.field;
  if (f === 'listname') { renameList(e.target.closest('[data-list]').dataset.list, e.target.value); return; }
  const t = S.items.get(T.editing);
  if (!t || !f) return;
  update(t, f === 'title' ? { text: e.target.value.replace(/\n/g, ' ') } : { details: e.target.value });
  autosize(e.target);
});
boardEl.addEventListener('change', (e) => {
  if (!inBoard() || !e.target.dataset.tqMove) return;
  const t = S.items.get(e.target.dataset.tqMove), to = e.target.value;
  ensureList(to);
  const first = openTasks(to)[0];
  update(t, { parent_id: to, pos: between('', first ? first.pos : '') });
  T.current = to; T.editing = null;
  repaint();
});
boardEl.addEventListener('keydown', (e) => {
  if (!inBoard()) return;
  const f = e.target.dataset && e.target.dataset.field;
  if (f === 'listname' && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); e.target.blur(); return; }
  if (e.key === 'Escape' && T.editing) { e.stopPropagation(); closeEdit(); repaint(); return; }
  if (f === 'title' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { // Intro: siguiente tarea, como en Recordatorios
    e.preventDefault();
    const t = S.items.get(T.editing);
    if (!t.text.trim()) { closeEdit(); repaint(); return; }
    const open = openTasks(t.parent_id), i = open.findIndex((x) => x.id === t.id), nx = open[i + 1];
    const n = create('task', { parent_id: t.parent_id, pos: between(t.pos, nx ? nx.pos : '') });
    T.editing = n.id;
    repaint(); focusTask(n.id);
  }
});
boardEl.addEventListener('focusout', (e) => {
  if (inBoard() && e.target.dataset && e.target.dataset.field === 'listname' && !e.target.value.trim()) {
    const id = e.target.closest('[data-list]').dataset.list;
    renameList(id, id === defaultListId() ? DEFAULT_LIST : 'Sin nombre');
    repaint();
  }
});
document.addEventListener('mousedown', (e) => {
  if (document.getElementById('tlmenu') && !e.target.closest('#tlmenu') && !e.target.closest('[data-lmenu]')) closeListMenu();
});
document.addEventListener('click', (e) => {
  if (!inBoard() || !T.editing) return;
  // composedPath y no closest: el tablero se repinta y el elemento pulsado ya puede no estar en la página
  const inside = e.composedPath().some((n) => n === boardEl || n.id === 'tveil' || n.id === 'tlmenu');
  if (!inside) { closeEdit(); repaint(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); closeListMenu(); } });
