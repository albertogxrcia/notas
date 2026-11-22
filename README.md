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

## Ponerla en marcha de verdad

1. **Supabase**: un proyecto en tu cuenta, aplicar `supabase/migrations`, desplegar la función
   `gcal` y meter `GCAL_SECRET` y `GCAL_SCRIPT_URL` como secretos de la función.
2. **Google Calendar**: pegar `google/Codigo.gs` en script.google.com, publicarlo como «Aplicación
   web» (Ejecutar como: yo · Acceso: cualquier usuario) y poner la URL en `.env`.
3. **config.js** con la URL y la clave pública del proyecto, y publicar la carpeta (Vercel).
4. Crear tu cuenta desde la app y **cerrar el registro** en Supabase para que nadie más entre.
