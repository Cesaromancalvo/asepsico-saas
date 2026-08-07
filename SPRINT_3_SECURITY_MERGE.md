# Sprint 3 integrado sobre la base de seguridad reforzada

## Funcionalidad
- Tareas terapéuticas por paciente.
- Estados: pendiente, en curso, completada y cancelada.
- Fecha límite, prioridad, instrucciones y seguimiento.
- Asociación opcional con objetivo terapéutico y sesión.
- Feedback del paciente y nota clínica separados.
- Panel de adherencia y filtros.
- Integración en la línea temporal clínica.

## Seguridad preservada
- JWT y cookies httpOnly.
- Protección CSRF.
- Aislamiento por workspaceId.
- Restricciones por rol y propiedad clínica.
- Auditoría de creación, actualización y eliminación.

## Puesta en marcha
```bash
npm install
npm run db:generate
npm run db:migrate
npm run typecheck
npm run dev:api
```

En otra terminal:
```bash
npm run dev:web
```
