# Verificación Sprint 11

## Ejecutado en el entorno de construcción
- Frontend TypeScript: correcto.
- Seguridad e integración: 9 suites, 48 pruebas, 48 superadas.
- Pruebas específicas de mensajería: acceso por rol, aislamiento, contador no leído, avisos prudentes, cierre del canal y adjuntos restringidos.

## Limitación del entorno
La generación local del cliente Prisma no pudo completarse porque el entorno no tenía acceso a `binaries.prisma.sh`. Por ese motivo, el typecheck global de la API sigue mostrando delegados antiguos del cliente Prisma compartido. En el Mac del usuario debe ejecutarse `npm run db:generate` tras `npm install`; el esquema y la migración de mensajería están incluidos.
