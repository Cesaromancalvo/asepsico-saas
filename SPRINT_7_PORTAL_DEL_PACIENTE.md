# Sprint 7 — Portal del paciente

## Alcance implementado
- Cuenta de portal independiente de las cuentas profesionales.
- Alta, restablecimiento y desactivación por OWNER, ADMIN o ASSISTANT.
- Inicio de sesión mediante cookie HttpOnly de 30 minutos.
- Bloqueo temporal tras cinco intentos fallidos.
- Contraseña temporal con cambio obligatorio y hash bcrypt (coste 12).
- Panel del paciente con próximas citas, enlace de videollamada, tareas activas, consentimientos y facturas emitidas.
- Exclusión explícita de historia clínica, notas de sesión, resumen interno, notas del profesional, escalas e informes clínicos.
- Aislamiento simultáneo por patientId y workspaceId.
- Auditoría de activación, desactivación y cambio de contraseña sin guardar contraseñas ni contenido clínico.

## Rutas
- `POST /api/v1/portal/auth/login`
- `POST /api/v1/portal/auth/logout`
- `GET /api/v1/portal/dashboard`
- `PATCH /api/v1/portal/password`
- `POST /api/v1/patients/:patientId/portal-account`
- `DELETE /api/v1/patients/:patientId/portal-account`
- Frontend: `/portal/login` y `/portal`

## Validación
La suite `portal.security-spec.ts` comprueba permisos de provisión, respuesta genérica de autenticación, bloqueo por intentos y minimización de datos clínicos.
