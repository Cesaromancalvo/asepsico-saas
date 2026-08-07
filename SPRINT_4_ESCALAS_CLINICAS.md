# Sprint 4 - Escalas clínicas y seguimiento longitudinal

Esta versión integra el Sprint 4 sobre la base segura que ya contenía los Sprints 1, 2 y 3.

## Funcionalidades incluidas

- Catálogo inicial de escalas PHQ-9, GAD-7 y WHO-5.
- Aplicación estructurada desde la ficha del paciente.
- Validación de número de respuestas y rango permitido en backend.
- Cálculo automático de puntuación total, nivel de severidad e interpretación orientativa.
- Señal de riesgo clínico cuando el ítem 9 del PHQ-9 es mayor que cero.
- Registro de fecha de aplicación y notas clínicas.
- Historial longitudinal por paciente y comparación con la aplicación anterior de la misma escala.
- Resumen visual con la última puntuación de cada escala.
- Integración de las evaluaciones en la línea temporal clínica.
- Eliminación auditada de evaluaciones.

## Seguridad

- Acceso protegido por autenticación y protección CSRF de la API existente.
- Verificación del workspace y del acceso clínico al paciente antes de leer o modificar evaluaciones.
- Los perfiles sin acceso clínico no pueden consultar las escalas ni sus resultados.
- Los pacientes archivados quedan bloqueados para nuevas aplicaciones o eliminaciones.
- Creación y eliminación registradas en AuditLog.
- No se incluyen archivos .env ni secretos en el paquete.

## Base de datos

Migración añadida:

`apps/api/prisma/migrations/20260726230000_add_clinical_assessments/migration.sql`

Modelo añadido:

`ClinicalAssessment`

## API

- `GET /api/v1/patients/:id/assessments/catalog`
- `GET /api/v1/patients/:id/assessments`
- `POST /api/v1/patients/:id/assessments`
- `DELETE /api/v1/patients/:id/assessments/:assessmentId`

## Frontend

Nueva ruta:

`/patients/[id]/assessments`

## Puesta en marcha

Desde la raíz del proyecto:

```bash
npm install
npm run db:generate
npm run db:migrate
npm run typecheck
npm run dev:api
```

En una segunda terminal:

```bash
npm run dev:web
```

## Nota clínica

Las interpretaciones automáticas son apoyo al registro y seguimiento, no sustituyen el juicio clínico ni constituyen un diagnóstico. Una respuesta positiva en el ítem 9 del PHQ-9 genera una alerta para activar el protocolo clínico del centro.
