// La llama la app después de subir cambios, con los ids que tocan un recordatorio.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { syncCalendar } from '../_shared/calendar.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: 'sin sesión' }, 401);
  const { ids } = await req.json().catch(() => ({ ids: [] }));
  const r = await syncCalendar(sb, user.id, Array.isArray(ids) ? ids : []);
  return json(r.body, r.status);
});
