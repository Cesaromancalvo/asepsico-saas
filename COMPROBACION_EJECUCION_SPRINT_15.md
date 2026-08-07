# Comprobación de ejecución — Sprint 15

## Alcance

Se ha revisado el workflow de CI con PostgreSQL real, el script de smoke HTTP y las conexiones entre los endpoints utilizados por el recorrido automático.

## Hallazgo corregido

El smoke test creaba un objetivo terapéutico con `priority: 'MEDIUM'`, pero `CreateTherapyGoalDto` exige un entero entre 1 y 3. En una ejecución real, el paso habría devuelto HTTP 400 y habría detenido el pipeline.

Se ha corregido a:

```js
priority: 2
```

También se ha añadido una comprobación de regresión a `scripts/verify-ci-postgres.mjs` para impedir que vuelva a introducirse una prioridad textual incompatible.

## Mejoras realizadas

- El job `quality` ejecuta ahora `npm run test:ci-config` antes de generar Prisma.
- El verificador del CI comprueba la compatibilidad básica del payload del objetivo terapéutico.
- Se validó la sintaxis del workflow, scripts Node y scripts Bash.

## Comprobaciones superadas en este entorno

- Workflow YAML válido.
- 11/11 comprobaciones estructurales del CI con PostgreSQL.
- 8/8 verificaciones del Sprint 13.
- 12/12 verificaciones del Sprint 14.
- Sintaxis correcta de `smoke-live.mjs`.
- Sintaxis correcta de `verify-ci-postgres.mjs`.
- Sintaxis correcta de los scripts de backup y restore.
- Correspondencia de rutas HTTP usadas por el smoke test con los controladores existentes.
- Correspondencia de los principales payloads con sus DTOs tras la corrección.

## Limitación de ejecución

No se pudo ejecutar localmente el recorrido completo con PostgreSQL porque el entorno actual no dispone de Docker. La instalación limpia de dependencias tampoco pudo completarse debido a que el registro npm interno devolvió un 404 para una dependencia. Esta limitación es del entorno de ejecución, no una prueba superada del producto.

La validación definitiva se realizará al ejecutar el workflow en GitHub Actions, donde el job levanta `postgres:16-alpine`, aplica migraciones, inicia NestJS y ejecuta el smoke HTTP real.

## Estado

**APROBADO para primera ejecución real en GitHub Actions**, con un fallo de contrato del smoke test detectado y corregido antes de la ejecución.
