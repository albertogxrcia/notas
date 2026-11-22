-- Adjuntos: una línea puede llevar un fichero (JSON: path, name, type, size, w, h).
alter table public.items add column file text;

-- Ficheros privados: cada usuario solo ve su carpeta <user_id>/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('adjuntos', 'adjuntos', false, 26214400)
on conflict (id) do nothing;

create policy adjuntos_leer on storage.objects for select to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy adjuntos_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy adjuntos_cambiar on storage.objects for update to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy adjuntos_borrar on storage.objects for delete to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Llaves de la API para Claude: solo se guarda su huella, nunca la llave.
create table public.api_keys (
  key_hash   text primary key,
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null default 'claude',
  created_at timestamptz not null default now()
);
alter table public.api_keys enable row level security; -- sin políticas: solo el servidor

-- Núcleo común: aplica filas para un usuario concreto con la regla de "gana el más reciente".
create or replace function public.apply_items(p_user uuid, rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if p_user is null then raise exception 'sin usuario'; end if;
  for r in select * from jsonb_array_elements(rows) loop
    insert into public.items as i
      (id, user_id, kind, parent_id, pos, text, task, done, pinned, deleted, remind_at,
       details, repeat, allday, color, file, updated_at, device, seq)
    values (
      (r->>'id')::uuid, p_user, r->>'kind', nullif(r->>'parent_id', '')::uuid,
      coalesce(r->>'pos', ''), coalesce(r->>'text', ''),
      coalesce((r->>'task')::boolean, false), coalesce((r->>'done')::boolean, false),
      coalesce((r->>'pinned')::boolean, false), coalesce((r->>'deleted')::smallint, 0),
      (r->>'remind_at')::bigint,
      coalesce(r->>'details', ''), r->>'repeat', coalesce((r->>'allday')::boolean, false), r->>'color', r->>'file',
      (r->>'updated_at')::bigint, coalesce(r->>'device', ''), nextval('public.items_seq'))
    on conflict (id) do update set
      kind = excluded.kind, parent_id = excluded.parent_id, pos = excluded.pos,
      text = excluded.text, task = excluded.task, done = excluded.done,
      pinned = excluded.pinned, deleted = excluded.deleted, remind_at = excluded.remind_at,
      details = excluded.details, repeat = excluded.repeat, allday = excluded.allday,
      color = excluded.color,
      file = case when r ? 'file' then excluded.file else i.file end, -- una versión antigua de la app no borra adjuntos
      updated_at = excluded.updated_at, device = excluded.device, seq = excluded.seq
    where i.user_id = p_user and (excluded.updated_at, excluded.device) > (i.updated_at, i.device);
  end loop;
end $$;
revoke execute on function public.apply_items(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_items(uuid, jsonb) to service_role;

-- La app sigue llamando a push_items: siempre con el usuario de su propia sesión.
create or replace function public.push_items(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sin sesión'; end if;
  perform public.apply_items(auth.uid(), rows);
end $$;
revoke execute on function public.push_items(jsonb) from public, anon;
grant execute on function public.push_items(jsonb) to authenticated;
