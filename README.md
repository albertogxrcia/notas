# Notas

Notas con tareas y recordatorios, con el aspecto de Notas de Apple, sincronizadas entre el Mac y
el Android. Es una web que se instala como app (PWA): en el Mac desde Chrome («Instalar Notas») o
Safari («Añadir al Dock»), y en Android desde Chrome («Añadir a pantalla de inicio»).

- **Tareas**: escribe `[] ` al principio de una línea, o pulsa el botón de lista (⌘⇧L en el Mac).
  ⌘↩ marca la tarea. Las hechas bajan solas al final, como en Notas.
- **Recordatorios**: con el cursor en una línea, botón de la campana. Van a un calendario
  «Notas» en tu Google Calendar, con aviso a la hora exacta, así que avisa en el Mac y en el móvil.
  Si marcas la tarea o la borras, el evento desaparece.
- **Tareas** (carpeta de la izquierda): todas las pendientes de todas las notas; arriba las que tienen aviso.
- **Sin conexión**: todo se guarda en el dispositivo y se sube al volver la red.

## Cómo está hecho

- `index.html`, `style.css`, `app.js`: la app entera, sin paso de compilación ni dependencias de CDN.
- `supabase/`: la base de datos (una tabla `items`) y la función `gcal`.
- `google/Codigo.plantilla.gs`: el Apps Script que escribe en tu Google Calendar.
  `google/Codigo.gs` es la misma con el secreto puesto (no se sube a git).
- `docs/rea-apple-notes.md`: lo que se sacó de Notas de Apple por ingeniería inversa y por qué
  la sincronización va por línea.

## Probar en local

```
supabase start -x studio,storage-api,imgproxy,logflare,vector,supavisor,postgres-meta
python3 -m http.server 5173 --bind 127.0.0.1
```
Abre `http://127.0.0.1:5173` y `http://localhost:5173`: son dos «dispositivos» distintos.

## En producción

- **App**: https://albertogxrcia.github.io/notas/ (GitHub Pages; se actualiza con `git push` a `main`).
- **Base de datos**: proyecto `notas` de Supabase. Cambios de esquema: nueva migración en
  `supabase/migrations` y `supabase db push`.
- **Función `gcal`**: `supabase functions deploy gcal --use-api`. Su único secreto es
  `GCAL_SCRIPT_URL` (la URL del Apps Script, que hace de llave).
- **Google Calendar**: Apps Script «Notas Calendar» en tu cuenta, publicado como «Aplicación web»
  (Ejecutar como: yo · Acceso: cualquier usuario). Si se vuelve a publicar con otra URL, cambia
  `.env` y el secreto de la función.
- `config.js` lleva la URL del proyecto y su clave pública (es pública por diseño; los datos los
  protege el inicio de sesión y las reglas de la tabla).
