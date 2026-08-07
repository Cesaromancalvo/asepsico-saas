# Revisión de seguridad e integración — Sprints 1 a 4

Fecha: 26 de julio de 2026

## Alcance

Se revisaron los módulos de pacientes, historia clínica, objetivos terapéuticos, tareas, escalas clínicas, timeline, autenticación, refresh tokens y protección CSRF.

## Pruebas ejecutadas

Se ejecutó la suite de integración de seguridad con Jest sobre NestJS:

- Acceso autenticado a rutas GET sin CSRF.
- Bloqueo de POST sin token CSRF.
- Bloqueo de POST con token CSRF distinto al de la cookie.
- Aceptación de POST con double-submit CSRF correcto.
- Rechazo de propiedades no permitidas por ValidationPipe.
- Bloqueo de contenido clínico para ASSISTANT.
- Ocultación de pacientes de otros workspaces.
- Bloqueo de THERAPIST sin proceso asignado.
- Validación de respuestas PHQ-9 fuera de rango.
- Detección del ítem 9 de PHQ-9 y auditoría.
- Rotación y protección del refresh token.
- Filtrado del listado de pacientes por terapeuta asignado.
- Bloqueo de acceso directo de un terapeuta a pacientes no asignados.

Resultado final: **13 pruebas superadas de 13**.

## Incidencias encontradas y corregidas

### 1. Importación incompatible de Supertest

La prueba HTTP utilizaba una importación por defecto que no era compatible con la configuración CommonJS usada por Jest. Se sustituyó por una importación `require`, permitiendo ejecutar correctamente las pruebas HTTP reales sobre NestJS.

### 2. Falta de aislamiento por terapeuta en listado y ficha de pacientes

El controlador enviaba únicamente `workspaceId` al servicio `PatientsService.list()` y `PatientsService.get()`. Esto permitía que un usuario con rol THERAPIST pudiera recuperar metadatos administrativos de otros pacientes del mismo workspace.

Corrección aplicada:

- `list()` y `get()` reciben ahora el actor autenticado.
- Para THERAPIST, el listado exige un proceso clínico del terapeuta.
- Los procesos y sesiones anidados también se filtran por terapeuta.
- La ficha individual devuelve `404` cuando el paciente no está asignado al terapeuta, evitando filtrar su existencia.
- OWNER conserva acceso a todos los pacientes de su workspace.

### 3. Pruebas de regresión añadidas

Se añadieron pruebas específicas para garantizar que el filtrado por terapeuta no vuelva a eliminarse en sprints posteriores.

## Controles verificados por inspección

- JWT obligatorio en el controlador de pacientes.
- CSRF obligatorio para operaciones de cambio de estado.
- `ValidationPipe` con `whitelist` y `forbidNonWhitelisted`.
- Separación de datos por `workspaceId` en pacientes, procesos y sesiones.
- Restricción del contenido clínico para ASSISTANT.
- Acceso clínico de THERAPIST condicionado a proceso asignado.
- Auditoría de creación, actualización y eliminación de información clínica.
- Las respuestas y notas clínicas completas no se copian al metadata del log de auditoría.
- Refresh tokens almacenados mediante hash y rotación de familia.
- Secreto JWT obligatorio en producción.

## Comprobaciones adicionales

- TypeScript del frontend: superado.
- Suite de seguridad backend: superada, 13/13.

## Limitación del entorno

No fue posible regenerar Prisma Client ni ejecutar el typecheck completo del backend porque el entorno no pudo resolver `binaries.prisma.sh`. No se ha ocultado ni sustituido esta comprobación. En un equipo con acceso a Internet se debe ejecutar:

```bash
npm install
npm run db:generate
npm run typecheck
npm run test:security --workspace @asepsico/api
```

La suite de integración se ejecutó usando las dependencias ya disponibles en el entorno y finalizó correctamente.
