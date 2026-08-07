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
Timeline basado en eventos; portal del paciente; IA con evidencias.
