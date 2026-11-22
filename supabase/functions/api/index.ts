// API de Notas para Claude (MCP por HTTP). Entra con una llave personal; solo se guarda su huella.
// A propósito no hay herramienta de borrar: Claude puede leer, crear y editar, nunca eliminar.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { syncCalendar } from '../_shared/calendar.ts';

const TZ = 'Europe/Madrid';
const MAX_MCP_IMAGE = 4 * 1024 * 1024;
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
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
const byPos = (a: any, b: any) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function sha256(s: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Hora local de Madrid -> instante real
function madridMs(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) throw new Error('Fecha u hora no válida (usa AAAA-MM-DD y HH:MM)');
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return guess - (shown - guess);
}
const fmt = (ms: number | null, allday?: boolean) => (ms ? new Intl.DateTimeFormat('es-ES', { timeZone: TZ, dateStyle: 'medium', ...(allday ? {} : { timeStyle: 'short' }) }).format(new Date(ms)) : null);

async function all(user: string, filter: (q: any) => any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(sb.from('items').select('*').eq('user_id', user)).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function one(user: string, id: string, kinds?: string[]) {
  const { data, error } = await sb.from('items').select('*').eq('user_id', user).eq('id', id).maybeSingle();
  if (error) throw new Error(/uuid/.test(error.message) ? 'Id no válido' : error.message);
  if (!data || data.deleted === 2 || (kinds && !kinds.includes(data.kind))) throw new Error('No existe ese elemento');
  return data;
}
async function save(user: string, rows: any[]) {
  const t = Date.now();
  const stamped = rows.map((r, i) => {
    const { seq: _s, user_id: _u, ...rest } = r;
    return { ...rest, updated_at: Math.max(t + i, (r.updated_at ?? 0) + 1), device: 'claude' };
  });
  const { error } = await sb.rpc('apply_items', { p_user: user, rows: stamped });
  if (error) throw new Error(error.message);
  const ids = stamped.filter((r) => ['line', 'task', 'note'].includes(r.kind) && (r.remind_at || r._cal)).map((r) => r.id);
  if (ids.length) await syncCalendar(sb, user, ids);
  return stamped;
}
const blank = (kind: string, f: any) => ({ id: crypto.randomUUID(), kind, parent_id: null, pos: '', text: '', task: false, done: false, pinned: false, deleted: 0, remind_at: null, details: '', repeat: null, allday: false, color: null, file: null, updated_at: 0, ...f });
function parseLines(noteId: string, content: string, after: string) {
  let pos = after;
  return content.replace(/\r\n?/g, '\n').split('\n').map((raw) => {
    const m = raw.match(/^\s*[-*]\s*\[( |x|X)?\]\s?/);
    pos = between(pos, '');
    return blank('line', { parent_id: noteId, pos, text: m ? raw.slice(m[0].length) : raw, task: !!m, done: !!m && /x/i.test(m[1] || '') });
  });
}
async function linesOf(user: string, noteId: string) {
  return (await all(user, (q) => q.eq('parent_id', noteId).eq('kind', 'line').eq('deleted', 0))).sort(byPos);
}
function dueFrom(a: any) {
  if (a.fecha === undefined) return {};
  if (a.fecha === null || a.fecha === '') return { remind_at: null, allday: false, repeat: null };
  return { remind_at: madridMs(a.fecha, a.hora || '09:00'), allday: !a.hora };
}
const fileOf = (l: any) => { try { return l.file ? JSON.parse(l.file) : null; } catch { return null; } };
const noteText = (ls: any[]) => ls.map((l) => {
  const f = fileOf(l);
  if (f) return `[adjunto ${l.id}: ${f.name}, ${f.type || 'fichero'}]`;
  return (l.task ? `- [${l.done ? 'x' : ' '}] ` : '') + l.text + (l.remind_at ? ` (aviso: ${fmt(l.remind_at, l.allday)})` : '');
}).join('\n');
const taskView = (t: any, lists?: Map<string, string>) => ({ id: t.id, titulo: t.text, detalles: t.details || undefined, lista: lists?.get(t.parent_id), hecha: t.done, destacada: t.pinned || undefined, fecha: fmt(t.remind_at, t.allday) ?? undefined, repite: t.repeat ? JSON.parse(t.repeat) : undefined });
async function listNames(user: string) {
  const ls = (await all(user, (q) => q.eq('kind', 'list').eq('deleted', 0))).sort(byPos);
  if (!ls.some((l) => l.id === user)) ls.unshift(blank('list', { id: user, text: 'Mis tareas', color: '#007aff' }));
  return ls;
}
async function resolveList(user: string, name?: string) {
  const ls = await listNames(user);
  const hit = name ? ls.find((l) => l.id === name || norm(l.text) === norm(name)) : ls.find((l) => l.id === user);
  if (!hit) throw new Error(`No hay ninguna lista «${name}». Listas: ${ls.map((l) => l.text).join(', ')}`);
  if (hit.updated_at === 0) await save(user, [hit]);
  return hit;
}

const str = (description: string) => ({ type: 'string', description });
const TOOLS = [
  { name: 'buscar', description: 'Busca texto en notas y tareas de Alberto.', inputSchema: { type: 'object', properties: { texto: str('Texto a buscar') }, required: ['texto'] } },
  { name: 'listar_notas', description: 'Lista las notas (id, título, fecha), las más recientes primero.', inputSchema: { type: 'object', properties: { limite: { type: 'number' } } } },
  { name: 'leer_nota', description: 'Lee una nota completa. Las tareas salen como "- [ ]" y los adjuntos con su id.', inputSchema: { type: 'object', properties: { id: str('Id de la nota') }, required: ['id'] } },
  { name: 'crear_nota', description: 'Crea una nota. La primera línea es el título; "- [ ] x" crea una tarea dentro.', inputSchema: { type: 'object', properties: { contenido: str('Texto de la nota') }, required: ['contenido'] } },
  { name: 'anadir_a_nota', description: 'Añade líneas al final de una nota sin tocar lo que ya hay.', inputSchema: { type: 'object', properties: { id: str('Id de la nota'), contenido: str('Texto a añadir') }, required: ['id', 'contenido'] } },
  { name: 'listar_listas', description: 'Lista las listas de tareas con sus pendientes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'listar_tareas', description: 'Lista tareas, por defecto solo pendientes.', inputSchema: { type: 'object', properties: { lista: str('Nombre de la lista (opcional)'), incluir_completadas: { type: 'boolean' }, limite: { type: 'number' } } } },
  { name: 'crear_tarea', description: 'Crea una tarea. Con fecha va también a Google Calendar.', inputSchema: { type: 'object', properties: { titulo: str('Título'), lista: str('Lista (por defecto Mis tareas)'), detalles: str('Detalles'), fecha: str('AAAA-MM-DD'), hora: str('HH:MM, hora de Madrid'), destacada: { type: 'boolean' } }, required: ['titulo'] } },
  { name: 'actualizar_tarea', description: 'Cambia una tarea o la marca como hecha. fecha="" quita la fecha.', inputSchema: { type: 'object', properties: { id: str('Id'), titulo: { type: 'string' }, detalles: { type: 'string' }, fecha: { type: 'string' }, hora: { type: 'string' }, hecha: { type: 'boolean' }, destacada: { type: 'boolean' } }, required: ['id'] } },
  { name: 'recordar_leer_nota', description: 'Pone (o quita con fecha="") un recordatorio para leer una nota; va a Google Calendar con enlace a la nota.', inputSchema: { type: 'object', properties: { id: str('Id de la nota'), fecha: str('AAAA-MM-DD'), hora: str('HH:MM, hora de Madrid') }, required: ['id', 'fecha'] } },
  { name: 'leer_adjunto', description: 'Devuelve un adjunto: la imagen si es pequeña y siempre un enlace temporal de 1 hora.', inputSchema: { type: 'object', properties: { id: str('Id del adjunto') }, required: ['id'] } },
  { name: 'adjuntar_fichero', description: 'Adjunta un fichero local del Mac al final de una nota (máx. 10 MB).', inputSchema: { type: 'object', properties: { nota_id: str('Id de la nota'), ruta: str('Ruta absoluta del fichero') }, required: ['nota_id', 'ruta'] } },
];

async function callTool(user: string, name: string, a: any): Promise<any> {
  const text = (o: unknown) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] });
  if (name === 'buscar') {
    const q = norm(String(a.texto || '')); if (!q) throw new Error('Falta el texto');
    const items = await all(user, (x) => x.eq('deleted', 0).in('kind', ['note', 'line', 'task']));
    const by = new Map(items.map((i) => [i.id, i]));
    const firsts = new Map<string, any>();
    for (const l of items) if (l.kind === 'line') { const f = firsts.get(l.parent_id); if (!f || byPos(l, f) < 0) firsts.set(l.parent_id, l); }
    const notas = new Map<string, any>(), tareas: any[] = [];
    for (const i of items) {
      if (!norm(`${i.text} ${i.details || ''}`).includes(q)) continue;
      if (i.kind === 'task') tareas.push(taskView(i));
      if (i.kind === 'line' && by.get(i.parent_id)) notas.set(i.parent_id, { id: i.parent_id, titulo: firsts.get(i.parent_id)?.text, coincide: i.text.slice(0, 160) });
    }
    return text({ notas: [...notas.values()].slice(0, 30), tareas: tareas.slice(0, 30) });
  }
  if (name === 'listar_notas') {
    const items = await all(user, (x) => x.eq('deleted', 0).in('kind', ['note', 'line']));
    const out = items.filter((n) => n.kind === 'note').map((n) => {
      const ls = items.filter((l) => l.kind === 'line' && l.parent_id === n.id).sort(byPos);
      return { id: n.id, titulo: ls[0]?.text || 'Nota nueva', modificada: Math.max(n.updated_at, ...ls.map((l) => l.updated_at)), fijada: n.pinned || undefined, aviso: fmt(n.remind_at, n.allday) ?? undefined };
    }).sort((x, y) => y.modificada - x.modificada).slice(0, Math.min(a.limite || 50, 200));
    return text(out.map((n) => ({ ...n, modificada: fmt(n.modificada) })));
  }
  if (name === 'leer_nota') { const n = await one(user, a.id, ['note']); return text({ id: n.id, aviso_de_lectura: fmt(n.remind_at, n.allday) ?? undefined, contenido: noteText(await linesOf(user, n.id)) }); }
  if (name === 'crear_nota') {
    const n = blank('note', {});
    const ls = parseLines(n.id, String(a.contenido || ''), '');
    await save(user, [n, ...ls]);
    return text({ id: n.id, titulo: ls[0]?.text });
  }
  if (name === 'anadir_a_nota') {
    const n = await one(user, a.id, ['note']); const ls = await linesOf(user, n.id);
    await save(user, parseLines(n.id, String(a.contenido || ''), ls.at(-1)?.pos || ''));
    return text('Añadido.');
  }
  if (name === 'listar_listas') {
    const ls = await listNames(user), ts = await all(user, (x) => x.eq('kind', 'task').eq('deleted', 0).eq('done', false));
    return text(ls.map((l) => ({ id: l.id, nombre: l.text, pendientes: ts.filter((t) => t.parent_id === l.id).length })));
  }
  if (name === 'listar_tareas') {
    const lists = await listNames(user), names = new Map(lists.map((l) => [l.id, l.text]));
    const target = a.lista ? await resolveList(user, a.lista) : null;
    const ts = await all(user, (x) => { let q = x.eq('kind', 'task').eq('deleted', 0); if (!a.incluir_completadas) q = q.eq('done', false); if (target) q = q.eq('parent_id', target.id); return q; });
    return text(ts.sort(byPos).slice(0, Math.min(a.limite || 100, 500)).map((t) => taskView(t, names)));
  }
  if (name === 'crear_tarea') {
    const l = await resolveList(user, a.lista);
    const first = (await all(user, (x) => x.eq('kind', 'task').eq('parent_id', l.id).eq('deleted', 0).eq('done', false))).sort(byPos)[0];
    const t = blank('task', { parent_id: l.id, pos: between('', first?.pos || ''), text: String(a.titulo), details: a.detalles || '', pinned: !!a.destacada, ...dueFrom(a) });
    await save(user, [t]);
    return text(taskView(t));
  }
  if (name === 'actualizar_tarea') {
    const t = await one(user, a.id, ['task']);
    const patch: any = { ...dueFrom(a), _cal: !!t.remind_at };
    if (a.titulo !== undefined) patch.text = String(a.titulo);
    if (a.detalles !== undefined) patch.details = String(a.detalles);
    if (a.destacada !== undefined) patch.pinned = !!a.destacada;
    if (a.hecha !== undefined) patch.done = !!a.hecha;
    if (a.fecha === undefined && a.hora && t.remind_at) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t.remind_at));
      patch.remind_at = madridMs(day, a.hora); patch.allday = false;
    }
    const [saved] = await save(user, [{ ...t, ...patch }]);
    return text(taskView(saved));
  }
  if (name === 'recordar_leer_nota') {
    const n = await one(user, a.id, ['note']);
    const [saved] = await save(user, [{ ...n, ...dueFrom(a), _cal: true }]);
    return text(saved.remind_at ? `Recordatorio para leerla: ${fmt(saved.remind_at, saved.allday)}` : 'Recordatorio quitado.');
  }
  if (name === 'leer_adjunto') {
    const l = await one(user, a.id, ['line']); const f = fileOf(l);
    if (!f) throw new Error('Esa línea no tiene adjunto');
    const { data, error } = await sb.storage.from('adjuntos').createSignedUrl(f.path, 3600);
    if (error) throw new Error(error.message);
    const content: any[] = [{ type: 'text', text: JSON.stringify({ nombre: f.name, tipo: f.type, bytes: f.size, enlace_1h: data.signedUrl }) }];
    if (String(f.type).startsWith('image/') && f.size <= MAX_MCP_IMAGE) {
      const { data: blob } = await sb.storage.from('adjuntos').download(f.path);
      if (blob) { let bin = ''; const u = new Uint8Array(await blob.arrayBuffer()); for (let i = 0; i < u.length; i += 32768) bin += String.fromCharCode(...u.subarray(i, i + 32768)); content.push({ type: 'image', data: btoa(bin), mimeType: f.type }); }
    }
    return { content };
  }
  if (name === 'adjuntar_fichero') { // el puente local (mcp/server.mjs) convierte "ruta" en nombre, tipo y base64
    if (!a.base64) throw new Error('Falta el contenido del fichero');
    const n = await one(user, a.nota_id, ['note']); const ls = await linesOf(user, n.id);
    const bytes = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0));
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Máximo 10 MB');
    const id = crypto.randomUUID(), safe = String(a.nombre || 'fichero').replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${user}/${id}-${safe}`;
    const { error } = await sb.storage.from('adjuntos').upload(path, bytes, { contentType: a.tipo || 'application/octet-stream' });
    if (error) throw new Error(error.message);
    const line = blank('line', { id, parent_id: n.id, pos: between(ls.at(-1)?.pos || '', ''), text: a.nombre || 'fichero', file: JSON.stringify({ path, name: a.nombre, type: a.tipo, size: bytes.length }) });
    await save(user, [line]);
    return text({ adjunto: id, nombre: a.nombre, bytes: bytes.length });
  }
  throw new Error('Herramienta desconocida');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Solo POST' }, 405);
  const key = (req.headers.get('x-notas-key') || '').trim();
  if (!key.startsWith('nk_')) return json({ error: 'Falta la llave' }, 401);
  const { data: k } = await sb.from('api_keys').select('user_id').eq('key_hash', await sha256(key)).maybeSingle();
  if (!k) return json({ error: 'Llave no válida' }, 401);
  const m = await req.json().catch(() => null);
  if (!m || !m.method) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } }, 400);
  if (m.id === undefined) return new Response(null, { status: 202 });
  const ok = (result: unknown) => json({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'notas', version: '1.0.0' }, instructions: 'Notas y tareas personales de Alberto. Fechas en hora de Madrid. No hay herramienta de borrar.' });
  if (m.method === 'ping') return ok({});
  if (m.method === 'tools/list') return ok({ tools: TOOLS });
  if (m.method === 'tools/call') {
    try { return ok(await callTool(k.user_id, m.params?.name, m.params?.arguments || {})); }
    catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }); }
  }
  return json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Método no disponible' } });
});
