#!/usr/bin/env node
// Importa un Tasks.json de Google Takeout (o su .zip) a Notas. Sin --aplica solo enseña el recuento.
// Repetirlo es seguro: cada tarea tiene un id fijo sacado de su id de Google, y no pisa lo editado después.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split('\n').map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const EMAIL = 'albertogxrcia@gmail.com';
const COLORS = ['#007aff', '#ff9500', '#34c759', '#ff3b30', '#af52de', '#ff2d55', '#a2845e', '#5ac8fa'];
const DIG = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const args = process.argv.slice(2), apply = args.includes('--aplica');
const dl = join(homedir(), 'Downloads');
const src = args.find((a) => !a.startsWith('--')) || readdirSync(dl).filter((f) => /^takeout.*\.zip$/i.test(f)).map((f) => join(dl, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!src) { console.error('No encuentro ningún takeout*.zip en Descargas'); process.exit(2); }

function readJson(path) {
  if (!/\.zip$/i.test(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 1e8 }).split('\n');
  const member = names.find((n) => /(^|\/)Tasks\.json$/i.test(n)) || names.find((n) => /tasks?\/.*\.json$/i.test(n)) || names.find((n) => /tareas?\/.*\.json$/i.test(n));
  if (!member) throw new Error('El zip no contiene Tasks.json');
  return JSON.parse(execFileSync('unzip', ['-p', path, member], { encoding: 'utf8', maxBuffer: 2e8 }));
}
const uuid = (s) => { const h = createHash('sha1').update('notas-gtasks:' + s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const key = (i) => { let n = (i + 1) * 100, o = ''; for (let k = 0; k < 4; k++) { o = DIG[n % 62] + o; n = Math.floor(n / 62); } return o; };
// Fecha de Google (día sin hora, en UTC) -> ese día a las 9:00 en Madrid
function dueMs(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number), guess = Date.UTC(y, m - 1, d, 9, 0);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  return guess - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess);
}
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

const data = readJson(src);
const lists = (data.items || data.lists || []).filter((l) => Array.isArray(l.items) || l.title);
const [{ id: user } = {}] = await sql(`select id from auth.users where email = '${EMAIL}'`);
if (!user) throw new Error('No existe la cuenta');
const rows = [], resumen = [];
let subtareas = 0, repetidas = 0;
lists.forEach((l, li) => {
  const isDefault = /^(mis tareas|my tasks)$/i.test((l.title || '').trim());
  const listId = isDefault ? user : uuid('list:' + (l.id || l.title));
  rows.push({ id: listId, kind: 'list', pos: isDefault ? '' : key(li), text: l.title || 'Sin nombre', color: COLORS[li % COLORS.length], updated_at: 1, device: 'google-tasks' });
  const ts = (l.items || []).filter((t) => !t.deleted && (t.title || t.notes));
  const tops = ts.filter((t) => !t.parent).sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')));
  const ordered = tops.flatMap((t) => [t, ...ts.filter((c) => c.parent === t.id).sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')))]);
  for (const t of ts) if (!ordered.includes(t)) ordered.push(t);
  ordered.forEach((t, i) => {
    if (t.parent) subtareas++;
    if (t.recurrence || t.task_recurrence) repetidas++;
    const done = t.status === 'completed' || !!t.completed;
    rows.push({ id: uuid('task:' + (t.id || `${l.title}:${i}:${t.title}`)), kind: 'task', parent_id: listId, pos: key(i), text: (t.title || '(sin título)').replace(/\s*\n\s*/g, ' '), details: t.notes || '', done, pinned: !!t.starred, remind_at: t.due ? dueMs(t.due) : null, allday: !!t.due, updated_at: Date.parse(t.completed || t.updated || '') || 2, device: 'google-tasks' });
  });
  resumen.push({ lista: l.title, pendientes: ordered.filter((t) => t.status !== 'completed' && !t.completed).length, completadas: ordered.filter((t) => t.status === 'completed' || t.completed).length });
});
console.table(resumen);
console.log(`Total: ${rows.filter((r) => r.kind === 'task').length} tareas en ${resumen.length} listas · ${subtareas} subtareas (quedan debajo de su tarea, sin sangría) · ${repetidas} con repetición (no se importa la regla)`);
if (!apply) { console.log('Prueba: no se ha escrito nada. Añade --aplica.'); process.exit(0); }
for (let i = 0; i < rows.length; i += 120) {
  const tag = 'j' + createHash('md5').update(String(i) + Date.now()).digest('hex').slice(0, 10);
  await sql(`select public.apply_items('${user}'::uuid, $${tag}$${JSON.stringify(rows.slice(i, i + 120))}$${tag}$::jsonb)`);
}
const [c] = await sql(`select count(*) filter (where kind = 'list' and deleted = 0)::int as listas, count(*) filter (where kind = 'task' and deleted = 0 and not done)::int as pendientes, count(*) filter (where kind = 'task' and deleted = 0 and done)::int as completadas from public.items where user_id = '${user}'`);
console.log('En la base ahora:', c);
