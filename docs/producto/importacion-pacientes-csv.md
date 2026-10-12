# Importar pacientes desde Excel o CSV

- **Autora:** Vega (producto)
- **Fecha:** 30/09/2026
- **Estado:** LISTA PARA DESARROLLO (Bruno y Fina), pendiente de las decisiones del apartado 11.
  Revisión de Argos obligatoria (toca `patients`, `clinical-processes`, auditoría y el esquema).
- **Depende de:** el modelo de acceso por proceso activo y el atributo `WorkspaceMember.isClinician`
  (épica de acceso clínico). Si esa épica no está fusionada, ver apartado 9.
- **Fuera de este documento:** importar citas, documentos o historia clínica; integraciones directas
  con otros programas.

---

## 1. Problema y usuario

- **Quién:** el psicólogo (profesional clínico) que llega desde otro programa de gestión, desde una
  hoja de cálculo o desde la agenda en papel, con 20–60 pacientes activos.
- **Cuándo:** el primer día. Si tiene que dar de alta a mano a 40 pacientes (1–2 horas), no llega a
  probar el producto con su consulta real.
- **Qué necesita:** que sus pacientes estén en AsePsico, a su nombre, con los datos de contacto
  correctos y sin duplicados, en menos de 10 minutos, sin que nadie más de la consulta vea nada que
  no deba ver.

## 2. Historias de usuario

- **H1.** Como psicólogo quiero descargar una plantilla, rellenarla o pegar mi exportación y subirla,
  para dar de alta a todos mis pacientes de una vez.
- **H2.** Como psicólogo quiero subir directamente el Excel o CSV que me da mi programa anterior y
  que AsePsico me proponga qué columna es cada dato, para no tener que reformatearlo.
- **H3.** Como psicólogo quiero ver antes de importar qué filas están bien, cuáles tienen errores y
  cuáles parecen duplicadas, para decidir yo.
- **H4.** Como psicólogo quiero que los pacientes importados queden a mi nombre y que ningún
  compañero vea su contenido clínico, para mantener la confidencialidad de mi consulta.
- **H5.** Como psicólogo quiero poder deshacer una importación reciente si me he equivocado de
  fichero.

## 3. Formato y columnas

### 3.1 Ficheros admitidos

| Aspecto | Regla |
|---|---|
| Formatos | `.csv` y `.xlsx` (primera hoja, o la que elija el usuario). `.xls` antiguo, `.numbers`, `.ods`: no; se pide guardarlo como `.xlsx` o `.csv` |
| Codificación CSV | UTF-8 (con o sin BOM) y Windows-1252; detección automática. Las tildes y la ñ deben verse bien en la vista previa |
| Separador CSV | `;`, `,` o tabulador; detección automática |
| Primera fila | Cabeceras. Si no las hay, el usuario asigna las columnas a mano |
| Tamaño máximo | **5 MB** y **2.000 filas** de datos por importación |
| Fórmulas, macros | Se leen los valores; nunca se ejecuta nada |

### 3.2 Plantilla descargable

Botón "Descargar plantilla" (CSV UTF-8 y XLSX) con estas columnas y **una fila de ejemplo con datos
ficticios** que el sistema ignora si se deja tal cual (se detecta por el valor `EJEMPLO` en la
columna `nombre`).

| Columna | Obligatoria | Formato | Campo en AsePsico |
|---|---|---|---|
| `nombre` | Sí | 2–80 caracteres | `Patient.firstName` |
| `apellidos` | Sí | 2–80 caracteres | `Patient.lastName` |
| `email` | No | Email válido, máx. 160 | `Patient.email` |
| `telefono` | No | Dígitos, espacios, `+`, `-`, paréntesis | `Patient.phone` |
| `prefijo` | No | `+34`, `34`, `0034`… Por defecto `+34` | Se antepone a `telefono` |
| `fecha_nacimiento` | No | `dd/mm/aaaa` o `aaaa-mm-dd` | `Patient.birthDate` |
| `estado` | No | `activo` o `alta`. Por defecto `activo` | `Patient.status` (`ACTIVE` o `DISCHARGED`) |

### 3.3 Mapeo asistido (ficheros de otros programas)

- El sistema propone la correspondencia por cabeceras conocidas (sin distinguir mayúsculas ni
  tildes): por ejemplo "Nombre", "First name" → `nombre`; "Apellidos", "Apellido 1" + "Apellido 2"
  → `apellidos` (se unen con un espacio); "Correo", "E-mail" → `email`; "Móvil", "Teléfono",
  "Tel." → `telefono`; "F. nacimiento", "Fecha de nacimiento" → `fecha_nacimiento`.
- El usuario puede cambiar cualquier asignación o marcar una columna como "No importar".
- Si hay dos columnas de teléfono, elige una; la otra no se importa.

## 4. Qué datos se importan

**Solo datos administrativos:** nombre, apellidos, email, teléfono, fecha de nacimiento y estado.

**No se importa ningún dato clínico**, tampoco el motivo de consulta, en esta versión:
- Las columnas con cabeceras como "motivo", "diagnóstico", "observaciones", "notas", "tratamiento",
  "medicación", "historia", "comentarios" o "antecedentes" se marcan automáticamente como **"No se
  importará: puede contener información clínica"** y **no se pueden asignar**.
- Cualquier columna sin asignar se descarta.
- **Justificación:** el contenido de esas columnas en ficheros ajenos es imprevisible (texto libre,
  datos de terceros, calidad desconocida), y meterlo en masa en la ficha sin revisión es un riesgo
  para el paciente y para el profesional. La historia anterior se incorporará más adelante como
  documento del paciente, revisado uno a uno. Además, así la importación es una operación
  puramente administrativa, más fácil de auditar y de deshacer.

Datos que el modelo no tiene (DNI, dirección, datos de facturación, tutores): no se importan en esta
versión. Los tutores de menores se completan a mano después.

## 5. Quién importa y a quién se asignan

| Rol | ¿Puede importar? | A quién quedan asignados |
|---|---|---|
| Profesional clínico (`isClinician`: THERAPIST, u OWNER/ADMIN que atiende) | **Sí** | **A sí mismo**, siempre. No puede elegir a otro profesional |
| OWNER/ADMIN no clínico | No | — |
| ASSISTANT | No (403) | — |
| Paciente (portal) | No | — |

- Cada paciente importado queda con **un proceso clínico mínimo a nombre del importador**: título
  "Proceso importado", sin motivo, objetivos ni notas. Estado `ACTIVE` si el paciente viene como
  `activo` y `CLOSED` (con fecha de cierre = fecha de importación) si viene como `alta`. Así el
  importador es "su profesional" según el modelo de acceso por proceso y nadie más ve su contenido
  clínico.
- **Qué ve el resto de la consulta** (modelo de acceso aprobado): los demás psicólogos **no** ven
  estos pacientes en sus listados ni búsquedas; la dirección (OWNER/ADMIN) y la recepción
  (ASSISTANT) ven **solo sus datos administrativos** (nombre, contacto, citas), como con cualquier
  otro paciente de la consulta. Nadie más que el importador ve contenido clínico.
- **Importar no crea cuentas de portal ni envía emails a pacientes.** El psicólogo invita al portal
  después, paciente a paciente.
- Pacientes menores de 18 años (según `fecha_nacimiento`): se crean con `portalAccessMode`
  pendiente de revisar y con un aviso "Completa tutores y modo de acceso al portal". Sin fecha de
  nacimiento no se presupone nada.

## 6. Vista previa, validación y duplicados

### 6.1 Flujo

1. **Subir** el fichero (o arrastrarlo). Se comprueba formato, tamaño y número de filas.
2. **Mapear** columnas (apartado 3.3).
3. **Vista previa**: tabla con todas las filas, cada una en uno de estos estados:
   - **Correcta** (se importará).
   - **Con error** (no se importará), con el motivo por columna: "email no válido", "fecha
     imposible", "falta el nombre", "teléfono con formato no válido".
   - **Posible duplicado**, con la regla que ha saltado.
   - **Fila de ejemplo o vacía** (se ignora).
   Resumen arriba: "38 correctas, 2 con error, 3 posibles duplicados".
4. **Decidir** cada posible duplicado: "Omitir" (por defecto), "Crear igualmente" o "Completar el
   existente" (solo rellena campos vacíos; nunca sobrescribe).
5. **Confirmar**: "Importar 41 pacientes". Nada se crea antes de este paso.
6. **Resultado**: resumen y botón "Descargar informe de errores" (CSV con número de fila, columna y
   motivo; **sin** los datos de la fila).

El usuario puede corregir el fichero y volver a subirlo en cualquier momento antes de confirmar.

### 6.2 Normalización

- Espacios sobrantes fuera; nombres respetando mayúsculas del original.
- Email en minúsculas.
- Teléfono: se quitan puntos y espacios dobles; se antepone el prefijo; debe cumplir el mismo
  formato que el alta manual.
- Fechas: `dd/mm/aaaa` o `aaaa-mm-dd`; en XLSX, fechas nativas de Excel. Fechas ambiguas
  (`03/04/2001` en ficheros con formato de EE. UU.) se interpretan como día/mes y se avisa.
- `fecha_nacimiento` debe cumplir la misma regla de fecha plausible que el alta manual.

### 6.3 Duplicados

- Se buscan **dentro del fichero** y **contra los pacientes que el importador ya puede ver** (los
  suyos). **Nunca contra toda la consulta**: comparar con pacientes de otros profesionales revelaría
  que otro compañero atiende a esa persona.
- Reglas (cualquiera basta): mismo email; mismo teléfono normalizado; mismo nombre + apellidos +
  fecha de nacimiento (sin distinguir tildes ni mayúsculas).
- Si otro profesional de la consulta ya atiende a esa persona, se creará un segundo registro. Los
  duplicados entre profesionales los resolverá la dirección con una herramienta administrativa
  posterior (fuera de alcance).

## 7. Auditoría, datos temporales y fallos

- **Lote:** cada importación confirmada es un lote con identificador, importador, fecha, número de
  filas creadas, omitidas y con error. Se audita como `PATIENT_IMPORT_BATCH` (metadatos: recuentos
  y nombre técnico del formato; **nunca** nombres, emails ni el nombre del fichero si puede contener
  datos personales).
- **Cada paciente creado** se audita como `PATIENT_CREATED` con `metadata.source = "IMPORT"` y el id
  del lote, en la misma transacción que su alta.
- **El fichero no se guarda.** Se procesa en el servidor; si hace falta conservarlo entre la subida y
  la confirmación, se guarda **cifrado**, asociado al usuario y al workspace, y se borra al confirmar,
  al cancelar o a las **24 horas**, lo que ocurra antes.
- **Logs:** nunca contienen valores de celdas. Los errores se registran como "fila 12, columna
  email: formato no válido".
- **Fallo a mitad:** la importación se hace **por bloques transaccionales** (propuesta: 100 filas por
  bloque). Si un bloque falla, ese bloque se deshace entero, los anteriores quedan creados, el lote
  se marca como `PARCIAL` y el usuario ve "Se han importado 200 de 350. Puedes volver a subir el
  mismo fichero: las filas ya importadas se detectarán como duplicadas y se omitirán." Nunca queda un
  paciente sin su proceso mínimo ni sin su auditoría.
- **Idempotencia:** subir dos veces el mismo fichero no duplica pacientes (lo impiden las reglas de
  duplicado, que se aplican también contra el propio lote anterior).
- **Deshacer el lote:** durante **7 días**, el importador puede deshacer un lote. Solo se eliminan
  los pacientes del lote **sin actividad posterior** (sin citas, notas, tareas, mensajes, documentos
  ni cuenta de portal); los demás se listan como "no se pueden deshacer". Se audita como
  `PATIENT_IMPORT_BATCH_REVERTED`. Es un borrado de altas erróneas del propio usuario, no un borrado
  de historia clínica.

## 8. Criterios de aceptación

**Subida y formato**
- Dado un profesional clínico, cuando sube un CSV en Windows-1252 separado por `;`, entonces la vista
  previa muestra bien tildes y eñes y las columnas separadas.
- Dado un fichero de más de 5 MB o más de 2.000 filas, cuando se sube, entonces se rechaza con un
  mensaje claro y no se procesa nada.
- Dado un `.xls` antiguo, cuando se sube, entonces se pide guardarlo como `.xlsx` o `.csv`.
- Dada la plantilla descargada sin modificar, cuando se sube, entonces la fila de ejemplo se ignora.

**Mapeo y datos**
- Dado un fichero con cabeceras "Nombre", "Apellido 1", "Apellido 2", "Móvil", cuando se sube,
  entonces el sistema propone `nombre`, `apellidos` (unidos) y `telefono`, y el usuario puede
  cambiarlos.
- Dado un fichero con una columna "Motivo de consulta" u "Observaciones", cuando se mapea, entonces
  aparece como "No se importará" y no se puede asignar a ningún campo.
- Dada una importación terminada, cuando se consulta cualquier paciente importado, entonces no tiene
  motivo de consulta, historia, objetivos ni notas.

**Vista previa y duplicados**
- Dado un fichero con 3 emails no válidos, cuando se valida, entonces esas 3 filas aparecen con error
  y motivo, el resto se puede importar, y el log no contiene los valores.
- Dado un paciente del propio importador con el mismo email, cuando se importa, entonces aparece como
  posible duplicado con "Omitir" por defecto y no se sobrescribe nada.
- Dado un paciente de **otro** profesional de la consulta con el mismo email, cuando el importador
  sube el fichero, entonces **no** recibe ninguna pista de su existencia.
- Dado un usuario que no confirma, cuando cierra la vista previa, entonces no se ha creado ningún
  paciente y el fichero temporal se borra.

**Asignación y visibilidad**
- Dado un psicólogo que importa 40 pacientes, cuando termina, entonces los 40 tienen un proceso
  mínimo a su nombre y aparecen en su listado.
- Dado otro psicólogo de la misma consulta, cuando lista o busca pacientes, entonces no ve ninguno de
  los importados y la API no los devuelve.
- Dado un OWNER/ADMIN no clínico o un ASSISTANT, cuando abre uno de esos pacientes, entonces solo ve
  datos administrativos.
- Dado un ASSISTANT o un OWNER/ADMIN no clínico, cuando llama al endpoint de importación, entonces
  recibe 403 y se audita el intento.
- Dada una petición de importación, cuando se procesa, entonces todos los registros llevan el
  `workspaceId` del importador y el proceso mínimo, su id de profesional.
- Dada una importación, cuando termina, entonces no se ha creado ninguna cuenta de portal ni se ha
  enviado ningún email a pacientes.

**Fallos, auditoría y deshacer**
- Dado un fallo en el tercer bloque, cuando ocurre, entonces los dos primeros bloques quedan creados
  y completos, el tercero no deja rastro, el lote queda `PARCIAL` y el usuario sabe cuántos se
  importaron.
- Dado el mismo fichero subido dos veces, cuando se confirma la segunda, entonces no se crea ningún
  paciente nuevo.
- Dado un lote de hace menos de 7 días, cuando el importador lo deshace, entonces se eliminan solo
  los pacientes sin actividad posterior y queda auditado.
- Dada cualquier importación, cuando se revisa la auditoría, entonces hay un evento de lote y uno
  por paciente creado, sin datos personales en los metadatos.

## 9. Si la épica de acceso clínico aún no está fusionada

No se libera la importación en consultas de más de un profesional: sin el filtro por proceso activo,
los pacientes importados serían visibles para los demás profesionales según las reglas actuales. En
workspaces de un solo profesional se puede liberar antes.

## 10. Para Argos (revisión obligatoria)

1. Que el endpoint rechace a ASSISTANT y a OWNER/ADMIN no clínicos, y que la asignación sea
   siempre al propio importador (no aceptar un `therapistId` del cliente).
2. Que la detección de duplicados no filtre información de pacientes de otros profesionales (ni
   por contenido ni por tiempos de respuesta o recuentos).
3. Que las columnas clínicas no puedan colarse (ni por mapeo manual ni por la API).
4. Fichero temporal: cifrado, aislado por workspace y usuario, borrado garantizado a las 24 horas.
5. Logs y auditoría sin valores de celdas ni nombre de fichero.
6. Análisis seguro de CSV/XLSX: sin ejecutar fórmulas ni macros, límites de tamaño aplicados antes de
   descomprimir (un XLSX es un ZIP), sin expansión de entidades XML, y **neutralizar la inyección de
   fórmulas** en el informe de errores que se descarga (celdas que empiezan por `=`, `+`, `-`, `@`).
7. Transaccionalidad por bloques, auditoría en la misma transacción y `workspaceId` en todas las
   escrituras.
8. Deshacer: que solo borre pacientes del propio lote, sin actividad, dentro del plazo, y que se
   audite.
9. Límite de peticiones en los endpoints de subida.

## 11. Decisiones pendientes del Jefe

1. ¿Importamos solo datos administrativos y dejamos fuera el motivo de consulta y las notas?
   (Recomendado: sí.)
2. ¿Se pueden importar también pacientes antiguos, ya dados de alta (quedan marcados como "alta")?
   (Recomendado: sí; ayudan a tener la agenda y la conservación ordenadas.)

## 12. Fuera de alcance

Importar citas, historia clínica, documentos, facturas o tutores; conexión directa con otros
programas; importación hecha por la dirección en nombre de otros profesionales; fusión de duplicados
entre profesionales; formatos distintos de CSV y XLSX.
