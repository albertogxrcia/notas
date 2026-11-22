-- Listas de tareas (tipo Google Tasks / Recordatorios): 'list' y 'task' en la misma tabla.
alter table public.items drop constraint items_kind_check;
alter table public.items add constraint items_kind_check check (kind in ('folder', 'note', 'line', 'list', 'task'));
alter table public.items
  add column details text not null default '',   -- detalles de la tarea
  add column repeat  text,                       -- regla de repetición (JSON) o null
  add column allday  boolean not null default false, -- fecha sin hora
  add column color   text;                       -- color de la lista

create or replace function public.push_items(rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select * from jsonb_array_elements(rows) loop
    insert into public.items as i
      (id, user_id, kind, parent_id, pos, text, task, done, pinned, deleted, remind_at,
       details, repeat, allday, color, updated_at, device, seq)
    values (
      (r->>'id')::uuid, auth.uid(), r->>'kind', nullif(r->>'parent_id', '')::uuid,
      coalesce(r->>'pos', ''), coalesce(r->>'text', ''),
      coalesce((r->>'task')::boolean, false), coalesce((r->>'done')::boolean, false),
      coalesce((r->>'pinned')::boolean, false), coalesce((r->>'deleted')::smallint, 0),
      (r->>'remind_at')::bigint,
      coalesce(r->>'details', ''), r->>'repeat', coalesce((r->>'allday')::boolean, false), r->>'color',
      (r->>'updated_at')::bigint, coalesce(r->>'device', ''), nextval('public.items_seq'))
    on conflict (id) do update set
      kind = excluded.kind, parent_id = excluded.parent_id, pos = excluded.pos,
      text = excluded.text, task = excluded.task, done = excluded.done,
      pinned = excluded.pinned, deleted = excluded.deleted, remind_at = excluded.remind_at,
      details = excluded.details, repeat = excluded.repeat, allday = excluded.allday, color = excluded.color,
      updated_at = excluded.updated_at, device = excluded.device, seq = excluded.seq
    where (excluded.updated_at, excluded.device) > (i.updated_at, i.device);
  end loop;
end $$;
