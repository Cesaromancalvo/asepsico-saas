# Verificación Sprint 8

Pruebas añadidas:
1. Aislamiento de bandeja profesional por workspace y userId.
2. Bloqueo de lectura de notificaciones ajenas.
3. Restricción del procesador a OWNER/ADMIN.
4. Idempotencia con claves de deduplicación y auditoría.
5. Aislamiento del portal por workspace y patientId.

La suite debe ejecutarse tras regenerar Prisma Client con `npm run db:generate`.
