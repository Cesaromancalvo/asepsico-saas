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

Demo: `demo@asepsico.es` / `AsePsico2026!`

## Estado
Implementados Identity, Workspace, Patients, Sessions (Agenda), Clinical Processes y Audit.
Los procesos clínicos y las notas de sesión están restringidos por rol (ver docs/ARCHITECTURE.md).
No introducir datos clínicos reales todavía sin completar el checklist de docs/SECURITY_BASELINE.md.
