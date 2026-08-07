# Revisión de usabilidad, integración y persistencia — Sprints 1 a 8

Fecha: 26/07/2026

## Resultado

- Suite automatizada: **8 suites, 39 pruebas superadas, 0 fallos**.
- Frontend: **typecheck TypeScript superado**.
- Conexiones revisadas entre frontend, controladores y servicios para pacientes, agenda, historia, objetivos, tareas, escalas, documentos, consentimientos, informes, facturación, portal y notificaciones.
- Se añadió un smoke test contra una instalación real para comprobar creación, guardado, recarga y archivado de datos.

## Problemas encontrados y corregidos

1. **El portal exigía cambio de contraseña, pero la interfaz no permitía hacerlo.**
   - El dashboard devuelve ahora `mustChangePassword`.
   - El portal bloquea el acceso funcional hasta sustituir la contraseña temporal.
   - Se añadieron validación de confirmación, mensajes de error y persistencia del cambio.

2. **Las notificaciones del paciente existían en backend, pero no estaban integradas en el portal.**
   - Se añadió bandeja de notificaciones.
   - Se añadió marcado como leído.
   - Se añadieron preferencias de avisos y confirmación de guardado.

3. **El procesador de recordatorios ignoraba las preferencias guardadas.**
   - Ahora respeta cada categoría activada o desactivada.
   - Respeta las horas de antelación configuradas entre 1 y 168 horas.
   - Mantiene deduplicación y auditoría.

4. **SMS podía generar una expectativa falsa cuando no existía teléfono.**
   - La preferencia se guarda desactivada y la interfaz informa del motivo.

## Persistencia comprobada automáticamente

Mediante dobles de Prisma con estado se verificó que:

- las preferencias se guardan y se recuperan con los mismos valores;
- el cambio de contraseña genera un nuevo hash y elimina el indicador temporal;
- las restricciones de seguridad anteriores permanecen activas;
- las preferencias desactivadas impiden generar el recordatorio correspondiente.

## Smoke test de base de datos real

Se incorpora:

```bash
npm run test:smoke
```

El script realiza contra la API activa:

1. Inicio de sesión profesional.
2. Creación de un paciente de prueba.
3. Guardado y recarga de historia clínica.
4. Creación y recarga de objetivo y tarea.
5. Creación y recarga de escala PHQ-9.
6. Creación y recarga de documento, consentimiento e informe.
7. Guardado y recarga de preferencias de notificación.
8. Consulta de la línea temporal.
9. Archivado del paciente de prueba.

Variables opcionales:

```bash
ASEPSICO_API_URL=http://localhost:4000/api/v1
ASEPSICO_SMOKE_EMAIL=demo@asepsico.es
ASEPSICO_SMOKE_PASSWORD=AsePsico2026!
```

## Limitaciones del entorno de verificación

No se pudo completar aquí una ejecución contra PostgreSQL real porque el entorno no dispone de PostgreSQL/Docker. Tampoco se pudo regenerar Prisma Client ni completar el build de Next.js porque la descarga externa de binarios devolvió errores de red. Estas limitaciones no se ocultan: el smoke test incluido permite cerrar la validación en una instalación local real.

## Criterio para avanzar

El código queda apto para validación local integral. Antes del Sprint 9 se recomienda ejecutar:

```bash
npm install
npm run db:generate
npm run db:migrate
npm run typecheck
npm --workspace @asepsico/api run test:security
npm run dev:api
```

En otra terminal:

```bash
npm run dev:web
npm run test:smoke
```

El Sprint 9 debe iniciarse solo cuando `test:smoke` finalice con `OK` en la base de datos local.
