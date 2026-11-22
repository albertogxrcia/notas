// Lleva recordatorios (líneas, tareas y notas) al Google Calendar de Alberto, vía su Apps Script.
const APP_URL = 'https://albertogxrcia.github.io/notas/';

// deno-lint-ignore no-explicit-any
export async function syncCalendar(sb: any, userId: string, ids: string[]) {
  const scriptUrl = Deno.env.get('GCAL_SCRIPT_URL');
  if (!scriptUrl) return { status: 503, body: { error: 'Google Calendar sin conectar' } };
  if (!ids.length) return { status: 200, body: { ok: true, results: [] } };

  const { data: rows, error } = await sb.from('items')
    .select('id,kind,parent_id,text,details,done,deleted,remind_at')
    .eq('user_id', userId).in('id', ids.slice(0, 200));
  if (error) return { status: 500, body: { error: error.message } };

  const parents = [...new Set(rows.flatMap((r: any) => (r.kind === 'note' ? [r.id] : r.parent_id ? [r.parent_id] : [])))] as string[];
  const { data: rel } = parents.length
    ? await sb.from('items').select('id,parent_id,kind,text,pos,deleted').eq('user_id', userId)
      .or(`id.in.(${parents}),parent_id.in.(${parents})`)
    : { data: [] };

  const parentDeleted = new Map<string, number>(), title = new Map<string, string>(), first = new Map<string, any>();
  for (const r of rel ?? []) {
    if (r.kind === 'note') parentDeleted.set(r.id, r.deleted);
    else if (r.kind === 'list') { parentDeleted.set(r.id, r.deleted); title.set(r.id, r.text); }
    else if (r.kind === 'line' && !r.deleted) {
      const f = first.get(r.parent_id);
      if (!f || r.pos < f.pos || (r.pos === f.pos && r.id < f.id)) { first.set(r.parent_id, r); title.set(r.parent_id, r.text); }
    }
  }
  const nameOf = (id: string, fallback: string) => (title.get(id) ?? '').trim() || fallback;
  const events = rows.map((r: any) => {
    if (r.kind === 'note') {
      return {
        id: r.id, title: `Leer: ${nameOf(r.id, 'Nota')}`, start: r.remind_at,
        description: `Abrir la nota: ${APP_URL}#n=${r.id}`,
        cancel: !r.remind_at || r.deleted > 0,
      };
    }
    const description = r.kind === 'task'
      ? [r.details, `Lista «${nameOf(r.parent_id, 'Mis tareas')}»`].filter(Boolean).join('\n\n')
      : `De la nota «${nameOf(r.parent_id, 'Nota')}»: ${APP_URL}#n=${r.parent_id}`;
    return {
      id: r.id, title: r.text.trim() || 'Recordatorio', start: r.remind_at, description,
      cancel: !r.remind_at || r.done || r.deleted > 0 || (parentDeleted.get(r.parent_id) ?? 0) > 0,
    };
  });

  const res = await fetch(scriptUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ events }) });
  const text = await res.text();
  try {
    const out = JSON.parse(text);
    return { status: out.error ? 502 : 200, body: out };
  } catch {
    return { status: 502, body: { error: 'El Apps Script no devolvió JSON', status: res.status } };
  }
}
