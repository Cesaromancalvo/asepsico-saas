# Sprint 13 — Dashboard profesional y onboarding

## Objetivo

Convertir la pantalla inicial de AsePsico en un centro de trabajo real, alimentado por datos del workspace, y acompañar al profesional durante la configuración inicial sin bloquear su uso.

## Implementado

### Dashboard profesional

- Saludo con el nombre real del profesional.
- Resumen de sesiones del día.
- Próxima sesión con acceso a ficha y preparación.
- Tareas terapéuticas entregadas pendientes de revisión.
- Mensajes de pacientes sin leer.
- Pacientes activos sin próxima cita.
- Accesos rápidos a paciente, cita, mensajes y facturación.
- Estados vacíos, carga y recuperación ante error.
- Diseño responsive.

### Onboarding

Checklist persistente y no bloqueante:

1. Perfil profesional configurado.
2. Primer paciente creado.
3. Primera cita programada.
4. Preferencias de recordatorios revisadas.

El progreso se infiere a partir de datos reales y se puede ocultar temporalmente.

### Backend

Nuevo módulo `DashboardModule`:

- `GET /dashboard`
- `PATCH /dashboard/onboarding`

El endpoint agrega datos existentes sin duplicar reglas de negocio.

### Base de datos

Se amplía `WorkspaceMember` con:

- `onboardingStep`
- `onboardingCompletedAt`
- `onboardingDismissedAt`

Incluye migración incremental.

### Seguridad

- Acceso limitado a OWNER, ADMIN y THERAPIST.
- Los terapeutas solo ven pacientes y procesos asignados.
- Todas las consultas están filtradas por workspace.
- El dashboard no expone respuestas clínicas ni cuerpos de mensajes.

## Fuera de alcance

- Widgets configurables.
- Analítica avanzada.
- Personalización visual del dashboard.
- Automatizaciones inteligentes.
- Onboarding por correo.
