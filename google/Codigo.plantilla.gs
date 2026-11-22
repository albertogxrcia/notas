/**
 * Notas -> Google Calendar.
 * Pega TODO este fichero en https://script.google.com (Proyecto nuevo) y publícalo:
 * Implementar > Nueva implementación > Tipo: Aplicación web > Ejecutar como: Yo > Acceso: Cualquier usuario.
 * Crea (una vez) un calendario "Notas" en tu Google Calendar y pone ahí cada recordatorio,
 * con aviso emergente a la hora exacta. Si marcas la tarea como hecha o la borras, el evento se va.
 */
const SECRET = '__GCAL_SECRET__';
const CAL_NAME = 'Notas';

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.secret !== SECRET) return json({ error: 'no autorizado' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cal = calendar_();
    const props = PropertiesService.getScriptProperties();
    const results = (body.events || []).map(function (ev) {
      try { return sync_(cal, props, ev); } catch (err) { return { id: ev.id, error: String(err) }; }
    });
    return json({ ok: true, results: results });
  } finally {
    lock.releaseLock();
  }
}

// Abre la URL en el navegador: si ves {"ok":true}, está vivo.
function doGet() { return json({ ok: true, calendario: calendar_().getName() }); }

function calendar_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CAL_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.getCalendarsByName(CAL_NAME)[0] || CalendarApp.createCalendar(CAL_NAME, { color: CalendarApp.Color.YELLOW });
    props.setProperty('CAL_ID', cal.getId());
  }
  return cal;
}

function sync_(cal, props, ev) {
  const key = 'ev_' + ev.id;
  const eventId = props.getProperty(key);
  let event = null;
  if (eventId) { try { event = cal.getEventById(eventId); } catch (err) { event = null; } }
  if (ev.cancel) {
    if (event) { try { event.deleteEvent(); } catch (err) {} }
    props.deleteProperty(key);
    return { id: ev.id, action: 'borrado' };
  }
  const start = new Date(ev.start), end = new Date(ev.start + 15 * 60000);
  if (event) {
    try { event.setTitle(ev.title); event.setTime(start, end); event.setDescription(ev.description || ''); }
    catch (err) { event = null; } // lo borraron a mano en Calendar: se crea de nuevo
  }
  if (!event) {
    event = cal.createEvent(ev.title, start, end, { description: ev.description || '' });
    props.setProperty(key, event.getId());
  }
  event.removeAllReminders();
  try { event.addPopupReminder(0); } catch (err) { event.addPopupReminder(5); }
  return { id: ev.id, action: 'guardado' };
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
