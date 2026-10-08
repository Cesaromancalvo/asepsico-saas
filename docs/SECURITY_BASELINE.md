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

## Antes de producción (pendiente)

- MFA para las cuentas de terapeutas/administradores.
- Ejecutar `npm run db:encrypt-fields` en producción tras desplegar (datos previos en claro).
- Gestión de secretos (Vault/Secrets Manager) en vez de variables de entorno planas.
- DPA con proveedores, DPIA, política de retención, exportación y borrado de datos (RGPD).
- Backups verificados con pruebas de restauración periódicas.
- SAST/DAST en CI y pruebas de penetración externas antes del primer cliente real.
- Revisión jurídica RGPD / normativa sanitaria aplicable.
- Rotar `JWT_SECRET` mediante un proceso definido y documentar el plan de respuesta a incidentes.
