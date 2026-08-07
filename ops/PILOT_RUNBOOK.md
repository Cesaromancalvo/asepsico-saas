# Runbook de piloto de AsePsico

## Antes de incorporar usuarios

1. Confirmar HTTPS, dominio y cookies seguras.
2. Ejecutar migraciones y generar Prisma Client.
3. Crear un backup y restaurarlo en una base aislada.
4. Verificar cuentas, roles, consentimiento y pacientes de prueba.
5. Ejecutar typecheck, tests de seguridad y smoke test.
6. Confirmar responsable de incidencias y ventana de soporte.

## Backups

- Frecuencia recomendada para piloto: diaria.
- Retención inicial: 30 días.
- Cifrado: el volumen o repositorio de destino debe estar cifrado.
- Prueba de restauración: semanal durante el piloto.
- Nunca guardar dumps en el repositorio Git.

## Incidente

1. Detener la operación afectada sin borrar evidencias.
2. Registrar hora, alcance, usuarios y datos potencialmente afectados.
3. Rotar secretos cuando exista sospecha de compromiso.
4. Restaurar únicamente desde una copia verificada.
5. Documentar causa, corrección y medidas preventivas.
