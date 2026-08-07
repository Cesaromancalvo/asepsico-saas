# Reintento de integración: Sprints 1 y 2 sobre base segura

Este paquete contiene el proyecto completo con:

- Historia clínica por paciente.
- Objetivos terapéuticos y plan clínico.
- Línea temporal clínica.
- Seguridad basada en workspace y roles.
- Restricción de contenido clínico para asistentes.
- Acceso de terapeutas limitado a pacientes/procesos autorizados.
- Auditoría de cambios clínicos.

## Puesta en marcha

```bash
npm install
npm run db:generate
npm run db:migrate
npm run typecheck
npm run dev:api
```

En otra terminal:

```bash
npm run dev:web
```

Copia `.env.example` a `.env` y completa las variables antes de arrancar.
