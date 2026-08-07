# Pruebas Sprint 13

## Verificaciones realizadas en el artefacto

- Módulo Dashboard registrado en `AppModule`.
- Endpoint de lectura y endpoint de actualización del onboarding presentes.
- Migración incremental incluida.
- Campos de onboarding incorporados al esquema Prisma.
- Dashboard web conectado a `/dashboard`.
- Manejo de carga, error y estados vacíos.
- Filtros por workspace y terapeuta presentes en el servicio.
- No se devuelve el cuerpo de mensajes ni respuestas clínicas en el resumen.
- ZIP validado tras su creación.

## Validación local pendiente

El entorno de ejecución no contiene las dependencias de React/Next instaladas, por lo que el typecheck no puede completarse aquí. El fallo observado es de resolución de módulos (`react`, `next`, tipos de Node), no una confirmación de error del Sprint 13.

Ejecutar localmente:

```bash
npm install
npm run db:generate
npm run db:migrate
npm --workspace @asepsico/web run typecheck
npm --workspace @asepsico/api run typecheck
npm --workspace @asepsico/api run test:security
```

## Recorrido funcional recomendado

1. Entrar con un profesional nuevo.
2. Comprobar que aparece el checklist.
3. Crear un paciente y recargar.
4. Programar una cita y recargar.
5. Revisar preferencias de avisos.
6. Ocultar el onboarding y comprobar persistencia.
7. Crear una tarea entregada y verificar el contador.
8. Enviar un mensaje desde el portal y verificar el contador.
9. Comprobar que un terapeuta no ve pacientes de otro profesional.
