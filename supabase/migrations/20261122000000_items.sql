-- Notas: una sola tabla para carpetas, notas y líneas (como ZICCLOUDSYNCINGOBJECT en Apple Notes).
-- Cada fila se sincroniza por separado: dos dispositivos que tocan líneas distintas de la misma
-- nota nunca se pisan. Si tocan la misma fila, gana el último cambio (updated_at, reloj híbrido).

create table public.items (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  kind        text not null check (kind in ('folder', 'note', 'line')),
  parent_id   uuid,                         -- nota -> carpeta (null = "Notas"), línea -> nota
  pos         text not null default '',     -- orden fraccional (base 62)
  text        text not null default '',
  task        boolean not null default false, -- la línea es una tarea
  done        boolean not null default false,
  pinned      boolean not null default false,
  deleted     smallint not null default 0,  -- 0 viva, 1 en "Eliminadas", 2 borrada del todo
  updated_at  bigint not null,              -- reloj híbrido del cliente (ms)
  device      text not null default '',     -- desempate cuando updated_at coincide
  seq         bigint not null default 0     -- orden de llegada al servidor, para tirar cambios
);

create sequence public.items_seq;
create index items_user_seq on public.items (user_id, seq);

alter table public.items enable row level security;
create policy items_own on public.items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Sube un lote de filas. Solo se aplica una fila si es más nueva que la guardada.
create or replace function public.push_items(rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select * from jsonb_array_elements(rows) loop
    insert into public.items as i
      (id, user_id, kind, parent_id, pos, text, task, done, pinned, deleted, updated_at, device, seq)
    values (
      (r->>'id')::uuid, auth.uid(), r->>'kind', nullif(r->>'parent_id', '')::uuid,
      coalesce(r->>'pos', ''), coalesce(r->>'text', ''),
      coalesce((r->>'task')::boolean, false), coalesce((r->>'done')::boolean, false),
      coalesce((r->>'pinned')::boolean, false), coalesce((r->>'deleted')::smallint, 0),
      (r->>'updated_at')::bigint, coalesce(r->>'device', ''), nextval('public.items_seq'))
    on conflict (id) do update set
      kind = excluded.kind, parent_id = excluded.parent_id, pos = excluded.pos,
      text = excluded.text, task = excluded.task, done = excluded.done,
      pinned = excluded.pinned, deleted = excluded.deleted,
      updated_at = excluded.updated_at, device = excluded.device, seq = excluded.seq
    where (excluded.updated_at, excluded.device) > (i.updated_at, i.device);
  end loop;
end $$;

grant execute on function public.push_items(jsonb) to authenticated;
grant select, insert, update on public.items to authenticated;
grant usage on sequence public.items_seq to authenticated;

-- Avisa en directo al otro dispositivo cuando cambia algo.
alter publication supabase_realtime add table public.items;
