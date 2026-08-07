# Sprint 2 — Plan terapéutico y evolución clínica

## Incluye
- Modelo `TherapyGoal` con prioridad, estado, fecha objetivo y fecha de logro.
- CRUD completo y auditado de objetivos terapéuticos.
- Endpoint de línea temporal clínica agregada.
- Nueva pantalla `/patients/[id]/plan`.
- Resumen de progreso, filtros de timeline y acciones rápidas.

## Endpoints
- `GET /patients/:id/goals`
- `POST /patients/:id/goals`
- `PATCH /patients/:id/goals/:goalId`
- `DELETE /patients/:id/goals/:goalId`
- `GET /patients/:id/timeline`

## Puesta en marcha
```bash
npm run db:generate
npm run db:migrate
npm run dev:api
```
En otra terminal:
```bash
npm run dev:web
```
