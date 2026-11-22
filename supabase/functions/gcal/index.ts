// Lleva los recordatorios de las notas al Google Calendar de Alberto, a través de su Apps Script.
// La llama la app después de subir cambios, con los ids de las líneas que tocan un recordatorio.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const scriptUrl = Deno.env.get('GCAL_SCRIPT_URL'), secret = Deno.env.get('GCAL_SECRET');
  if (!scriptUrl || !secret) return json({ error: 'Google Calendar sin conectar' }, 503);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: 'sin sesión' }, 401);

  const { ids } = await req.json().catch(() => ({ ids: [] }));
  if (!Array.isArray(ids) || !ids.length) return json({ ok: true, results: [] });

  // Con la sesión del usuario: solo ve sus filas (RLS)
  const { data: lines, error } = await sb.from('items')
    .select('id,parent_id,text,done,deleted,remind_at').in('id', ids.slice(0, 200));
  if (error) return json({ error: error.message }, 500);
  const noteIds = [...new Set(lines.map((l) => l.parent_id).filter(Boolean))];
  const { data: rel } = noteIds.length
    ? await sb.from('items').select('id,parent_id,kind,text,pos,deleted').or(`id.in.(${noteIds}),parent_id.in.(${noteIds})`)
    : { data: [] };
  const noteDeleted = new Map<string, number>(), title = new Map<string, string>();
  const firstPos = new Map<string, string>();
  for (const r of rel ?? []) {
    if (r.kind === 'note') noteDeleted.set(r.id, r.deleted);
    else if (r.kind === 'line' && !r.deleted) {
      const p = firstPos.get(r.parent_id);
      if (p === undefined || r.pos < p || (r.pos === p)) { firstPos.set(r.parent_id, r.pos); title.set(r.parent_id, r.text); }
    }
  }
  const events = lines.map((l) => ({
    id: l.id,
    title: l.text.trim() || 'Recordatorio',
    start: l.remind_at,
    description: `De la nota «${(title.get(l.parent_id) ?? '').trim() || 'Nota'}»`,
    cancel: !l.remind_at || l.done || l.deleted > 0 || (noteDeleted.get(l.parent_id) ?? 0) > 0,
  }));

  const r = await fetch(scriptUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ secret, events }) });
  const text = await r.text();
  let out;
  try { out = JSON.parse(text); } catch { return json({ error: 'El Apps Script no devolvió JSON', status: r.status }, 502); }
  return json(out, out.error ? 502 : 200);
});
