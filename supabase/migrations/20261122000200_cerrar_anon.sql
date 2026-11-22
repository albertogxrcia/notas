-- push_items solo para usuarios con sesión (Postgres da EXECUTE a PUBLIC por defecto)
revoke execute on function public.push_items(jsonb) from public, anon;
grant execute on function public.push_items(jsonb) to authenticated;
