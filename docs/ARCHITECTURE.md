# Arquitectura de AsePsico

## Decisiones
- Monorepo con npm workspaces.
- Web en Next.js App Router.
- API modular en NestJS.
- PostgreSQL y Prisma.
- JWT Bearer para la primera vertical funcional.
- Multi-tenancy por `workspaceId` aplicado en todos los accesos a pacientes.
- Auditoría transaccional para altas, modificaciones y archivo.

## Dominios implementados
1. Identity: registro, login, refresh tokens rotativos y JWT en cookie httpOnly.
2. Workspace: creación de consulta y membresía inicial.
3. Patients: CRUD con paginación, filtro por estado, flujo de transición de estados y soft delete/restore.
4. Sessions (Agenda): programación de citas, detección de solapamientos por profesional, reprogramación y cierre (completada/cancelada/no-show), con control de acceso por rol.
5. Clinical Processes: episodio de tratamiento que agrupa sesiones de un paciente con un terapeuta (motivo, objetivos, notas internas, modalidad). Contiene el contenido clínico narrativo más sensible del sistema.
6. Audit: registro de acciones sensibles.

Dominios posteriores (detalle en `ROADMAP_ASEPSICO.md` y los `SPRINT_X_*.md`): portal del paciente,
notificaciones, mensajería, exportaciones, acceso excepcional, reserva de citas desde el portal,
alta en el portal con el QR del profesional (`portal-signup`) y baja de miembros del equipo
(`workspace-members`, Sprint 18).

## Sesiones revocables
Además de firma y caducidad, `JwtAuthGuard` revalida en cada petición que la membresía siga `ACTIVE`
y que el `tokenVersion` del token coincida con el del usuario; si no, 401 `SESSION_REVOKED` y la web
vuelve al login. Detalle en `docs/SECURITY_BASELINE.md`.

## Control de acceso a contenido clínico
`ASSISTANT` (recepción) no tiene ningún acceso a `ClinicalProcess`: solo gestiona Patients y Sessions
para agendar. Un `THERAPIST` solo puede leer/editar/cerrar sus propios procesos; `OWNER`/`ADMIN`
pueden ver y gestionar cualquiera del workspace. Las transiciones de estado están validadas
(`CLOSED` es terminal; `DISCHARGED` puede reabrirse a `ACTIVE`).

Importante: `GET /patients` y `GET /patients/:id` **nunca** devuelven motivo de consulta, objetivos
o notas internas de un proceso clínico, ni notas de sesión — solo campos operativos (título,
modalidad, frecuencia, estado, terapeuta asignado). El contenido narrativo solo se sirve desde
`GET /clinical-processes/:id` y `GET /sessions/:id`, que sí aplican el control de acceso anterior.
Esto es intencional: evita que la vista general de pacientes se convierta en una puerta trasera
que salte el control de acceso por terapeuta/rol.

## Próximos dominios
Timeline basado en eventos; IA con evidencias.
