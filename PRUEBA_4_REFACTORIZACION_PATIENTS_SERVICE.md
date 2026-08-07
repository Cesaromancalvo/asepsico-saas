# Paso 4 — Refactorización de `patients.service.ts`

## Objetivo

Reducir el riesgo del antiguo servicio monolítico de pacientes, que concentraba más de 1.000 líneas y múltiples responsabilidades clínicas y administrativas.

## Refactorización realizada

El servicio original se ha dividido en:

- `patient-core.service.ts`: ficha del paciente, listado, consulta, creación, actualización, estados, archivo y restauración.
- `patient-access.service.ts`: autorización clínica centralizada y validación de asignación del terapeuta.
- `patient-care.service.ts`: historia clínica y objetivos terapéuticos.
- `patient-tasks.service.ts`: plantillas, tareas terapéuticas y timeline.
- `patient-assessments.service.ts`: catálogo y aplicación de escalas clínicas.
- `patient-records.service.ts`: documentos, consentimientos e informes.
- `patients.service.ts`: fachada compatible con el controlador y con los tests existentes.

## Compatibilidad

Se mantiene la API pública de `PatientsService`, por lo que el controlador no necesita cambiar.

También se conserva la construcción usada en tests existentes:

```ts
new PatientsService(prisma)
```

En ejecución NestJS, los servicios extraídos se registran como providers y se inyectan. En tests unitarios antiguos, la fachada crea dependencias por defecto cuando no se proporcionan.

## Seguridad

La autorización clínica se ha centralizado en `PatientAccessService.assertPatientClinicalAccess()`.

Los servicios de historia, tareas, evaluaciones y registros llaman a este guard antes de acceder a datos de un paciente.

Se mantiene:

- aislamiento por workspace;
- acceso del terapeuta solo a pacientes asignados;
- rechazo de roles sin permiso clínico;
- bloqueo de modificaciones sobre pacientes archivados.

## Pruebas añadidas

Se añadió:

```text
apps/api/test/patients-architecture.security-spec.ts
```

La prueba evita regresiones arquitectónicas comprobando que:

1. `PatientsService` sigue siendo una fachada pequeña.
2. Cada servicio extraído permanece por debajo de 600 líneas.
3. La autorización clínica permanece centralizada.
4. Todos los servicios están registrados en `PatientsModule`.

## Verificaciones ejecutadas

- 22 comprobaciones estructurales específicas del paso 4: superadas.
- 8 verificaciones del Sprint 13: superadas.
- 12 verificaciones del Sprint 14: superadas.
- No se detectaron errores sintácticos específicos de los nuevos archivos durante el intento de typecheck.

## Limitación del entorno

No se pudo ejecutar Jest ni un typecheck completo porque el ZIP no incluye `node_modules` y el entorno no dispone de las dependencias de NestJS y Prisma instaladas.

El intento de `tsc --noEmit` falla principalmente por módulos ausentes (`@nestjs/common`, `@prisma/client`, `class-validator`, etc.), no por una validación concluyente del refactor.

## Validación local recomendada

```bash
npm ci
npm run db:generate
npm --workspace @asepsico/api run typecheck
npm --workspace @asepsico/api run test:security
npm --workspace @asepsico/api run test:e2e
```

## Estado

Refactorización completada e integrada. Pendiente de validación dinámica completa en un entorno con dependencias instaladas y PostgreSQL disponible.
