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
- Control de acceso por rol a contenido clínico (`ClinicalProcess`): `ASSISTANT` sin acceso;
  `THERAPIST` solo a sus propios procesos; `OWNER`/`ADMIN` a cualquiera. Las vistas generales de
  Patients/Sessions nunca exponen motivo de consulta, objetivos, notas internas ni notas de
  sesión — solo el detalle de cada proceso/sesión, que sí aplica ese control.
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

**Exportación (arts. 15/20 RGPD):** un THERAPIST solo exporta sus propios procesos y sesiones
(ni facturación), con el mismo alcance que la API. La exportación clínica descifra con los mismos helpers y,
como red de seguridad, descifra cualquier string que aún lleve prefijo `enc:` (registrando solo
la ruta, nunca el valor).

## Antes de producción (pendiente)

- MFA para las cuentas de terapeutas/administradores.
- Ejecutar `npm run db:encrypt-fields` en producción tras desplegar (datos previos en claro).
- Gestión de secretos (Vault/Secrets Manager) en vez de variables de entorno planas.
- DPA con proveedores, DPIA, política de retención, exportación y borrado de datos (RGPD).
- Backups verificados con pruebas de restauración periódicas.
- SAST/DAST en CI y pruebas de penetración externas antes del primer cliente real.
- Revisión jurídica RGPD / normativa sanitaria aplicable.
- Rotar `JWT_SECRET` mediante un proceso definido y documentar el plan de respuesta a incidentes.
