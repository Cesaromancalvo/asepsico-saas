# Sprint 1 - Historia clínica

## Incluido

- Modelo Prisma `ClinicalHistory` con relación 1:1 con `Patient`.
- Migración SQL `20260726180000_add_clinical_history`.
- DTO validado para actualizar la historia clínica.
- Endpoints:
  - `GET /api/v1/patients/:id/history`
  - `PATCH /api/v1/patients/:id/history`
- Guardado mediante `upsert` y registro de auditoría.
- Nueva ficha clínica en `/patients/[id]`.
- Acceso «Abrir ficha» desde el listado de pacientes.
- Resumen clínico, antecedentes, evaluación, sesiones recientes y diseño responsive.

## Primer arranque tras sustituir el proyecto

Desde la raíz del proyecto:

```bash
npm run db:generate
npm run db:migrate
npm run dev:api
```

En otra terminal:

```bash
npm run dev:web
```

Cuando Prisma solicite el nombre de la migración, puedes usar:

```text
add_clinical_history
```

La migración SQL ya está incluida, por lo que normalmente Prisma solo la aplicará.
