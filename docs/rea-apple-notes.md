# Cómo está hecho Notas de Apple (ingeniería inversa, 22-nov-2026)

Análisis de `/System/Applications/Notes.app` (macOS, arm64, sha256 `d95c1110…7637`) con REA + Hopper,
y del **esquema** (solo columnas, ningún contenido) de su base local
`~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.

## Lo observado

| Qué | Dónde se ve | Qué es |
|---|---|---|
| Una tabla para todo | `ZICCLOUDSYNCINGOBJECT`; entidades Core Data `ICNote`, `ICFolder`, `ICAccount`, `ICAttachment`, `ICHashtag` heredan de `ICCloudSyncingObject` (`Z_PRIMARYKEY`) | Carpetas, notas y adjuntos son filas de la misma tabla, cada una sincronizable por separado |
| Cuerpo aparte | `ZICNOTEDATA.ZDATA` | El texto de la nota va en otra tabla, comprimido |
| Fijadas | columna `ZISPINNED`; clases `ICMNoteListPinnedNotesSectionHeader`, `predicateForPinnedNotes` | Un booleano por nota; la lista pinta una sección "Fijadas" arriba |
| Tareas | `todoWithDone:`, `checklistParagraphUUID`, `ZHASCHECKLIST`, `ZHASCHECKLISTINPROGRESS` | Una tarea NO es un objeto aparte: es un **párrafo con estilo "todo"** y un `done`, con su propio UUID. "Tiene tareas" se calcula después (`ICUpdateDerivedChecklistAttributesLaunchTask`) |
| Ordenar tareas | `ICChecklistAutoSortEnabledDefaultsKey`, `autoSortChecklistCheckbox` | Opción para que las hechas bajen al final |
| Filtro de tareas | `SmartFolderChecklistsFilterView`, `ChecklistsFilterSelectionType` | Carpeta inteligente con las notas que tienen tareas |
| Sincronización | `makeCloudKitRecordForApproach:mergeableFieldState:`, `mergeCloudKitRecord:…`, `ICTTMergeableAttributedString`, `ZMERGEABLEDATA`, `ZICSERVERCHANGETOKEN` | CloudKit. El texto es un **tipo fusionable** (CRDT, "topotext"): dos dispositivos que editan la misma nota sin conexión se fusionan sin pisarse. Se piden cambios con un *change token* |
| Borrado | `ZMARKEDFORDELETION`, "Eliminados recientemente" | Borrado suave, papelera de 30 días |
| Título | `ZNOTEUSINGTITLEFORNOTETITLE`, `fillNote:hasTitle:…` | El título es la primera línea |

## Qué copiamos y qué simplificamos

- **Una tabla `items`** para carpetas, notas y líneas, como `ZICCLOUDSYNCINGOBJECT`.
- **La tarea es una línea con `task` y `done`**, como el párrafo "todo" con UUID de Apple.
- **Sincronizar por línea en vez de por carácter.** Apple fusiona carácter a carácter (CRDT). Aquí
  cada línea es una fila con su reloj: dos dispositivos que tocan líneas distintas nunca chocan;
  si tocan la misma línea a la vez, gana el último. Para un solo usuario es casi lo mismo y mucho
  más simple. Si algún día hace falta fusión por carácter, el paso es Yjs/Automerge por nota.
- **Cursor de cambios** (`seq`) en lugar del *change token* de CloudKit.
- **Fijadas, papelera de 30 días, título = primera línea, autoordenar tareas hechas**: igual.

## Lo que no se miró

El formato exacto de `ZDATA` (protobuf comprimido), adjuntos, notas bloqueadas, colaboración y
el código de `NotesShared.framework` (va dentro de la caché compartida del sistema, no como fichero).
No hacían falta para esta app.
