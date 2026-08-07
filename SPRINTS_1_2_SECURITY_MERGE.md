# Integración de Sprints 1 y 2 sobre la versión reforzada

Esta entrega conserva la base de seguridad de `fixes-round2` e integra:

- Sprint 1: historia clínica por paciente.
- Sprint 2: objetivos terapéuticos, plan y línea temporal.

## Controles añadidos a los módulos clínicos

- `ASSISTANT` no puede leer ni modificar historia clínica, objetivos ni timeline clínico.
- `THERAPIST` solo puede acceder si tiene al menos un proceso clínico propio asociado al paciente.
- `OWNER` y `ADMIN` pueden acceder dentro de su workspace.
- Todas las consultas verifican `workspaceId`.
- Escrituras sensibles generan auditoría.
- Actualización y eliminación de objetivos usan filtros por paciente.
- La línea temporal de un terapeuta solo incluye sus procesos y sesiones.
- La vista general de pacientes no devuelve notas de sesión ni contenido narrativo de procesos.

## Puesta en marcha

```bash
npm install
npm run db:generate
npm run db:migrate
npm run dev:api
```

En otra terminal:

```bash
npm run dev:web
```

La instalación de dependencias no pudo completarse en el entorno de generación por timeout de red. Ejecuta `npm install` localmente antes de validar con `npm run typecheck`.
