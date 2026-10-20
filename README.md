# AsePsico — NestJS Foundation

Primera vertical funcional de producción: Next.js + NestJS + PostgreSQL + Prisma.

## Requisitos
- Node.js 20.9+
- Docker Desktop

## Arranque
```bash
cp .env.example .env
docker compose up -d postgres redis minio
npm install
npm run db:generate
npm run db:migrate -- --name init
npm run db:seed
```
En dos terminales:
```bash
npm run dev:api
npm run dev:web
```
- Web: http://localhost:3000
- Swagger: http://localhost:4000/docs
- Health: http://localhost:4000/api/v1/health

Cuenta demo local: `demo@asepsico.es`. La contraseña sale de `SEED_DEMO_PASSWORD` (en `.env`) o,
si no la defines, el seed genera una aleatoria y la imprime una vez. El seed se niega a ejecutarse
con `NODE_ENV=production` o contra una BD que no sea local (salvo `--allow-production-seed`) y,
siempre, si la BD tiene usuarios que no son demo o workspaces distintos de "Consulta Demo".

## Estado
Implementados Identity, Workspace, Patients, Sessions (Agenda), Clinical Processes y Audit, más los
módulos posteriores que recoge `ROADMAP_ASEPSICO.md` (estado real de cada sprint).
Los procesos clínicos y las notas de sesión están restringidos por rol (ver docs/ARCHITECTURE.md).
No introducir datos clínicos reales todavía sin completar el checklist de docs/SECURITY_BASELINE.md.
