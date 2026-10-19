# Security baseline

Esta entrega es una base de desarrollo reforzada, pero todavía no una certificación para
datos clínicos reales en producción.

## Incluido ahora

- Helmet con Content-Security-Policy explícita (sin `unsafe-inline` en scripts, sin frames).
- Validación estricta de entrada (`whitelist` + `forbidNonWhitelisted`).
- Hash de contraseñas con bcrypt (coste 12) y comparación en tiempo constante también cuando
  el email no existe (evita enumeración de usuarios por timing).
- Sesión basada en cookies `httpOnly` + `SameSite=Lax` (ya no en `localStorage`, invisible a XSS).
- Access token JWT de vida corta (15 min) + refresh token opaco de un solo uso con rotación:
  cada `/auth/refresh` invalida el token anterior y emite uno nuevo. Si un token ya revocado
  se reutiliza (señal de robo/filtración), se revoca toda la familia de sesiones derivadas de
  ese login.
- Cambio de contraseña de los profesionales (`POST /auth/change-password`, pantalla
  `/settings/security`): exige la contraseña actual y, con MFA activo, un código TOTP no usado
  (no acepta códigos de recuperación); OWNER/ADMIN/THERAPIST sin MFA reciben 403
  `MFA_SETUP_REQUIRED` y los tokens del portal, 401. Política: 12 caracteres mínimo y 72 bytes
  UTF-8 máximo, bcrypt coste 12. En una sola transacción guarda el nuevo hash, revoca **todos**
  los refresh tokens del usuario, audita `USER_PASSWORD_CHANGED` (sin correo, IP ni user agent)
  y emite una sesión nueva para el navegador actual. En la misma transacción sube
  `User.tokenVersion` y guarda `passwordChangedAt`: los access tokens ya emitidos en otros
  dispositivos dejan de valer en su siguiente petición (ver el punto siguiente).
- Revalidación del access token en **cada** petición (`JwtAuthGuard` → `assertActiveSession`):
  además de firma y caducidad, exige contra la BD que la membresía del workspace del token siga
  `ACTIVE` y que el claim `tv` del token coincida con `User.tokenVersion`. Si no, 401 con código
  estable `SESSION_REVOKED` (la web renueva con el refresh token o vuelve al login). Suben
  `tokenVersion`: el cambio de contraseña y desactivar el MFA (el token vivo decía
  `mfaEnabled=true`). Los tokens emitidos antes de existir `tv` cuentan como versión 0. Login,
  refresh y `/auth/me` ignoran membresías que no estén `ACTIVE`.
- Baja de un miembro del equipo (`POST /workspace-members/:userId/remove`, OWNER/ADMIN; ADMIN solo
  sobre THERAPIST/ASSISTANT; nadie a sí mismo ni al último OWNER): la membresía pasa a `REMOVED`
  con fecha, autor y motivo de lista cerrada (CHECK `REMOVED ⇔ removedAt`); **no se borra** ni la
  fila ni el `User`, así que la autoría y la auditoría se conservan. En una transacción, serializada
  por workspace y con el lock de la agenda del profesional: revoca sus refresh tokens de ese
  workspace, cierra sus accesos excepcionales (`MEMBER_REMOVED`), rechaza sus solicitudes de cita
  pendientes, desactiva su reserva desde el portal y audita `MEMBER_REMOVED` con recuentos. La
  reserva del portal revalida bajo ese mismo lock (409 `BOOKING_UNAVAILABLE`). Con destino (o más
  tarde con `POST :userId/reassign`), sus procesos ACTIVE/PAUSED y las citas futuras sin proceso o
  de esos procesos pasan a otro profesional clínico activo, con 409 si choca con su agenda
  (`REASSIGN_SCHEDULE_CONFLICT`) o si ya tiene un proceso abierto con el paciente
  (`REASSIGN_PROCESS_CONFLICT`); una cita con resumen interno del que se va no se mueve (no se
  expone ni se borra). `MEMBER_WORK_REASSIGNED` guarda ids de procesos y citas, sin nombres.
  Mientras no se reasigne ("decidir después"), los avisos de mensajes del portal y los
  recordatorios dirigidos al miembro dado de baja se reenvían a los OWNER/ADMIN activos del
  espacio; los selectores de profesional, la reserva y los destinatarios de avisos solo usan
  membresías `ACTIVE`.
- Protección CSRF con patrón *double-submit cookie* en los endpoints que modifican estado.
- Rate limiting: 5 intentos/minuto en login y registro; 10/minuto en refresh; 100/minuto global.
- Aislamiento por `workspaceId` aplicado tanto en lectura como en las propias operaciones de
  escritura (defensa en profundidad, no solo una comprobación previa).
- Acceso al contenido clínico decidido en un único punto (`ClinicalAccessService`, falla en
  cerrado y audita las denegaciones como `CLINICAL_ACCESS_DENIED`): solo un miembro con
  `WorkspaceMember.isClinician` (nunca `ASSISTANT`, garantizado también por un CHECK en la BD)
  con proceso **ACTIVO** con el paciente; el autor de un proceso no activo conserva solo la
  lectura de lo suyo. `OWNER`/`ADMIN` por su rol solo ven datos administrativos. Notas internas
  (`ClinicalProcess.internalNotes`, `Session.internalSummary`): solo su autor. Mensajes con el
  paciente: solo quien le trata y solo los de la ventana de sus procesos; el resto, metadatos.
  `isClinician` solo lo cambia el OWNER (auditado) y no da acceso a ningún paciente por sí solo.
  Las vistas generales de Patients/Sessions nunca exponen motivo de consulta, objetivos, notas
  internas ni notas de sesión.
- Citas entre profesionales (`GET /sessions/patient/:patientId/agenda`): un `THERAPIST` que
  trata al paciente ve sus citas con metadatos de agenda y, de las de otros profesionales, solo
  las programadas futuras con id, inicio, fin y nombre del profesional (sin estado, notas,
  proceso, tipo, lugar ni enlace). Quien no lo trata recibe 403 auditado. `OWNER`, `ADMIN` y
  `ASSISTANT` conservan la vista administrativa de la agenda.
- Cerrar o dar de alta un proceso con citas futuras programadas devuelve 409
  `PROCESS_HAS_FUTURE_SESSIONS` (citas solo como metadatos) salvo `cancelFutureSessions: true`,
  que las cancela en la misma transacción con auditoría por cita. Crear o reprogramar una cita
  exige proceso `ACTIVE` y bloquea la fila del proceso en la misma transacción, igual que el
  cierre: no puede quedar una cita programada nueva en un proceso cerrado.
- Bandeja de mensajes (`GET /messages`): cada fila lleva `therapist` (`id`, `firstName`,
  `lastName`) del proceso activo del paciente, nunca contenido. `OWNER`/`ADMIN` lo ven siempre
  (quién atiende a quién es dato administrativo); un `THERAPIST` solo en los pacientes que trata
  ahora (el autor de un proceso cerrado no averigua quién le sustituye). `ASSISTANT` no accede a
  la bandeja (403), así que tampoco lo ve.
- Soft delete y auditoría transaccional para altas, modificaciones y archivado de pacientes.

## Cifrado a nivel de campo (en reposo)

AES-256-GCM con IV aleatorio por valor (`apps/api/src/common/crypto/field-encryption.ts`).
La lista de campos cifrados es única y vive en `apps/api/src/common/crypto/clinical-crypto.ts`:
la usan los servicios al escribir y leer, la exportación, el script de migración y los tests
(`encrypted-fields-writes.security-spec.ts` falla si un campo del registro no se escribe cifrado).

| Modelo | Campos cifrados |
|---|---|
| `Patient` | `consultationReason` |
| `ClinicalHistory` | `reasonForConsultation`, `currentProblem`, `personalHistory`, `familyHistory`, `medicalHistory`, `currentMedication`, `primaryDiagnosis`, `riskFactors`, `protectiveFactors`, `clinicalObservations` |
| `TherapyGoal` | `title`, `description` |
| `TherapeuticTask` | `title`, `instructions`, `clinicianNotes`, `reviewComment`, `patientFeedback` |
| `TherapeuticTaskTemplate` | `instructions` |
| `ClinicalProcess` | `consultationReason`, `goals`, `internalNotes` |
| `Session` | `notes`, `internalSummary` |
| `ClinicalAssessment` | `answers` (Json cifrado como texto), `interpretation`, `clinicalNotes`, `result` (JSON cifrado con `totalScore`, `severity`, `riskFlag`) |
| `ClinicalReport` | `content` |
| `PatientDocument` | `description`, `fileName` |
| `ConsentRecord` | `notes` |
| `Message` | `body`, `attachmentName` |
| `User` | `totpSecret` |
| `WaitlistEntry` (lista de espera pública, sin workspace) | `name`, `email`, `tools` (+ `emailHash` HMAC para deduplicar) |

**Fuera del cifrado (decisión consciente o pendiente):**

- `Patient.firstName`, `lastName`, `email`, `phone`, `birthDate`: se buscan y ordenan en BD.
  Protegidos por control de acceso, TLS y cifrado del disco/backups del proveedor.
- Puntuación, gravedad y alerta de riesgo de las escalas: ya no existen columnas en claro
  (`totalScore`, `severity`, `riskFlag` se eliminaron tras migrar su contenido a `result`).
  Consecuencia aceptada: no se puede filtrar ni ordenar por ellas en SQL. El `AuditLog` de
  escalas no las copia y el portal del paciente no recibe `riskFlag`.
- Títulos de documentos, consentimientos, informes y procesos, `Session.location` y
  `videoCallUrl`, `scaleName`, y metadatos (fechas, estados, tipos, ids, `storageKey`, `mimeType`).
- `AuditLog.metadata` no lleva contenido clínico (solo nombres de campo e ids).

**Formatos y claves:**

- `enc:v1:<iv>:<tag>:<ct>` con `FIELD_ENCRYPTION_KEY` (histórico; sigue siendo el formato por
  defecto si no se configura llavero).
- `enc:v2:<kid>:<iv>:<tag>:<ct>` con el llavero `FIELD_ENCRYPTION_KEYS="kid:clave,…"`; se escribe
  siempre con `FIELD_ENCRYPTION_ACTIVE_KID` y se lee con el `kid` del propio valor. Los v1 se
  siguen leyendo con `FIELD_ENCRYPTION_KEY`.
- En producción, sin clave la API lanza al cifrar. Un llavero mal formado o un kid activo
  inexistente lanza siempre.
- Nunca se persiste el marcador `[No se pudo descifrar este contenido]`: `encryptField` responde
  422 si se intenta guardar, y ningún camino re-cifra un valor leído (p. ej. reprogramar una
  sesión solo toca las notas si llegan en la petición).
- Autocomprobación al arrancar (`FieldEncryptionCheckService`): ida y vuelta con la clave activa
  y descifrado del valor cifrado más reciente de varias columnas. Si ninguna muestra se puede
  descifrar, en producción la API no arranca (clave equivocada); solo registra modelo/campo/kid.
- Las notificaciones al paciente (tarea próxima a vencer, consentimiento que caduca) usan texto
  genérico y no copian títulos; el dashboard no selecciona notas de sesión.

**Migración y rotación:** `npm run db:encrypt-fields -- --dry-run` (solo cuenta),
`npm run db:encrypt-fields` (cifra lo que siga en claro) y `-- --rotate` (re-cifra con la clave
activa). Idempotente, por lotes transaccionales con compare-and-set, conserva `updatedAt`,
nunca imprime valores y aborta sin escribir si algún valor cifrado no se puede descifrar.

**Exportación (arts. 15/20 RGPD):** mismo alcance que la API: quien trata al paciente exporta su
contenido clínico (sin notas internas ajenas); el autor de un proceso no activo, solo lo suyo;
OWNER/ADMIN que no le tratan, 403 (custodia y copia del art. 15 sin terapeuta: pendientes).
THERAPIST nunca exporta facturación. La exportación clínica descifra con los mismos helpers y,
como red de seguridad, descifra cualquier string que aún lleve prefijo `enc:` (registrando solo
la ruta, nunca el valor).

## Lista de espera pública (`/api/v1/public/waitlist`)

Endpoint público, sin sesión ni CSRF, llamado desde la landing estática (módulo `apps/api/src/waitlist/`; contrato en
`docs/WAITLIST_API.md`). No pertenece a ningún workspace y no admite datos de salud.

- CORS propio solo para esa ruta (`WAITLIST_ALLOWED_ORIGINS`, por defecto `https://asepsico.es` y
  `https://www.asepsico.es`, sin credenciales) y además se exige la cabecera `Origin` permitida
  (403 si falta o no coincide). El resto de la API sigue con `WEB_ORIGIN`.
- Anti-abuso sin terceros: rate limit por IP (`req.ip`, `TRUST_PROXY`) de 5 envíos y 20 tokens
  cada 10 min, honeypot `website` (202 idéntico sin guardar) y token de formulario firmado
  (HMAC, sin estado ni cookies) con tiempo mínimo de 3 s y caducidad de 2 h.
- Cuerpo máximo de 16 KB en la ruta (413) y solo JSON (415), antes de los parsers globales.
- Alta solo con `create` (nunca upsert): un email repetido o dos altas simultáneas chocan en el
  índice único de `emailHash` (P2002) y reciben el mismo 202 sin tocar la fila existente.
- **Sin comunicaciones comerciales (política `lista-espera-v3`, 17/10/2026):** el formulario ya no
  tiene la casilla de novedades ni de comunicaciones comerciales, y quien se apunta solo recibe
  mensajes sobre su solicitud y el piloto. La API rechaza con 400 (`WAITLIST_COMMERCIAL_NOT_OFFERED`)
  un alta v3 con `commercialConsentRequested=true`. Decisión de producto: se borra la marca
  `commercialConsentRequested` de las altas anteriores (v2); las columnas `commercialConsent*` y los
  CLI `waitlist:confirm-commercial` / `waitlist:withdraw-commercial` quedan solo por compatibilidad y
  **no se usan**. Ofrecer comunicaciones comerciales en el futuro exigiría una política nueva con
  consentimiento separado y doble opt-in.
- No se guarda IP ni user-agent; el contador del rate limit vive solo en memoria y caduca.
  Logs sin nombre, email, herramientas, hash ni IP (test `waitlist.security-spec.ts`).
- `WAITLIST_SECRET` (obligatorio en producción) deriva dos subclaves: hash del email y firma del
  token. No se rota: rompe la deduplicación y `waitlist:delete` de las altas previas.
- Gestión solo por CLI: `npm run waitlist:export -- --out <ruta fuera del repo>` (CSV descifrado,
  permisos 600, sin sobrescribir, celdas neutralizadas contra fórmulas) y
  `npm run waitlist:delete -- --email <email>` (vacía todos los datos personales y el hash; deja
  `deletedAt`) y `npm run waitlist:purge` (plazo de 12 meses; tarea mensual en el runbook). Las
  claves de producción solo se usan en ejecuciones puntuales, nunca en un `.env` permanente.

## Registro por invitación y aceptación de condiciones

- **Registro cerrado:** `POST /auth/register` solo funciona con una invitación de plataforma de un
  solo uso (`npm run invites:create -- --email x`; solo el hash SHA-256 en la BD, caduca a los 14 días,
  ligada al correo). Cualquier fallo responde 400 neutro `REGISTRATION_NOT_ALLOWED`.
- **Condiciones versionadas** (`apps/api/src/legal/`): en el piloto demo están vigentes las
  condiciones de uso del piloto demo (`PILOT_TERMS`, `demo-1.1`) y la política de privacidad para
  profesionales (`PRIVACY_PRODUCT`, `demo-1.1`). El contrato art. 28 (`DPA_ART28`) **no** está
  vigente durante el demo (sigue en borrador y no debe haber datos de pacientes); vuelve con el
  piloto real. Cada profesional acepta por sí mismo: el titular al registrarse (`POST /auth/register`)
  y cada miembro invitado al darse de alta (`POST /auth/register/member`). Cada aceptación guarda
  la versión, el hash SHA-256 del texto, la fecha, la IP y el user agent, y se audita en la misma
  transacción. Si hay una versión nueva, cualquier profesional con condiciones pendientes recibe
  428 `TERMS_ACCEPTANCE_REQUIRED` hasta aceptarla (`POST /legal/terms/accept`).
- **Textos sin marcadores en producción:** un texto que conserve cualquier marcador sin rellenar
  (`[NIF]`, `[DOMICILIO]`, `[PENDIENTE DEL DESPACHO]`...) es borrador. Con `NODE_ENV=production`
  registro, alta de miembros y aceptación responden 503 `LEGAL_TERMS_DRAFT`. No hay válvula de
  escape (`LEGAL_ALLOW_DRAFT` se eliminó y se ignora).
- **Datos del titular fuera del repositorio:** `[NIF]` y `[DOMICILIO]` se sustituyen al arrancar con
  `LEGAL_TITULAR_NIF` y `LEGAL_TITULAR_DOMICILIO`, definidas solo en el panel de Render. El NIF se
  valida (DNI/NIE con letra de control) y el domicilio debe ser una línea sin corchetes; si faltan o
  no son válidos, el marcador se queda y el texto sigue en borrador (503). Los valores nunca se
  registran en logs. Cambiar cualquiera de ellos cambia el hash y obliga a aceptar de nuevo.
- **Entorno de prueba:** `GET /api/v1/environment` (público) devuelve `{ demo }`. Solo
  `DEMO_ENVIRONMENT=false` lo pone a `false`; por defecto la web muestra el aviso fijo.
- **Miembros invitados:** aceptan las mismas condiciones vigentes que el titular, y la respuesta de
  `POST /auth/register/member` incluye además la política de privacidad (`privacyNotice`, art. 13
  RGPD), cuya versión queda en la auditoría (`MEMBER_JOINED`).
- **Conservación de la evidencia frente a la supresión:** `TermsAcceptance` referencia a `User` y a
  `Workspace` con `ON DELETE RESTRICT`. La prueba de qué contrato se aceptó, quién lo aceptó y cuándo
  se conserva aunque el usuario pida la supresión, porque es necesaria para la formulación, el
  ejercicio o la defensa de reclamaciones (art. 17.3.e RGPD). Por eso, al suprimir un usuario **no
  se borra su fila de `User`**: se **seudonimiza**. Se sustituyen el correo, el nombre y los
  apellidos por valores no identificativos, se invalidan la contraseña, el MFA y los refresh tokens,
  y se eliminan sus membresías. Así se mantienen las aceptaciones y la auditoría. Plazo de
  conservación (piloto demo): la evidencia de aceptación y la auditoría se conservan **bloqueadas
  3 años** desde el fin de la prueba o la baja, y después se suprimen (política de privacidad del
  demo, apartado 4). **Pendiente:** el procedimiento de purga a los 3 años.
  **TODO (flujo de supresión de cuentas de profesionales):** todavía no existe. Cuando se
  implemente, debe seudonimizar en lugar de borrar, en una transacción auditada, y nunca saltarse el
  `RESTRICT`.

## Reserva de citas desde el portal: límites de frecuencia

- El límite de 30 peticiones/minuto va **en memoria y por instancia**: con varias instancias el
  límite efectivo se multiplica por su número y se pierde al reiniciar.
- El conteo de 5 solicitudes/hora por cuenta se hace **fuera de la transacción** de alta; dos
  peticiones simultáneas pueden pasarlo a la vez y superar el límite en una o dos solicitudes. Los
  topes de pendientes por paciente y el hueco retenido sí se aplican dentro de la transacción.
- Vale para una sola instancia. **Antes de escalar a varias instancias hay que pasar ambos
  contadores a Redis** (contador atómico con caducidad).

## Antes de producción (pendiente)

- MFA para las cuentas de terapeutas/administradores.
- Ejecutar `npm run db:encrypt-fields` en producción tras desplegar (datos previos en claro).
- Gestión de secretos (Vault/Secrets Manager) en vez de variables de entorno planas.
- DPA con proveedores, DPIA, política de retención, exportación y borrado de datos (RGPD).
- Backups verificados con pruebas de restauración periódicas.
- SAST/DAST en CI y pruebas de penetración externas antes del primer cliente real.
- Revisión jurídica RGPD / normativa sanitaria aplicable.
- Rotar `JWT_SECRET` mediante un proceso definido y documentar el plan de respuesta a incidentes.
