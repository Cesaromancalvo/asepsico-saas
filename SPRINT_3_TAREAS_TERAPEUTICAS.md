# Sprint 3 — Tareas terapéuticas y seguimiento entre sesiones

## Incluido
- Modelo `TherapeuticTask` con estado, vencimiento, objetivo y sesión asociados.
- Endpoints protegidos por JWT, CSRF, workspace y propiedad clínica.
- Auditoría de altas, cambios y eliminaciones.
- Vista `/patients/[id]/tasks` con creación, filtros, adherencia y seguimiento.
- Feedback del paciente y nota clínica diferenciados.
- Integración de tareas en la línea temporal clínica.

## Arranque
```bash
npm install
npm run db:generate
npm run db:migrate
npm run dev:api
npm run dev:web
```
