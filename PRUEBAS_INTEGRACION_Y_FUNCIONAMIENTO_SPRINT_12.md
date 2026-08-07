# Pruebas de integración y funcionamiento — Sprint 12

Fecha de ejecución: 27/07/2026

## 1. Resultado ejecutivo

Estado global: **APROBADO CON BLOQUEOS DE ENTORNO PARA E2E EN VIVO**.

Se han ejecutado correctamente las pruebas automatizadas disponibles del backend, incluidas las pruebas específicas del flujo de tareas terapéuticas. No se ha podido completar una prueba E2E real con navegador, API y PostgreSQL porque este entorno no dispone de una instalación completa y operativa de las dependencias ni de una base de datos PostgreSQL arrancada.

## 2. Pruebas automatizadas ejecutadas

Comando:

```bash
npm --workspace @asepsico/api run test:security
```

Resultado:

- 10 suites superadas
- 52 pruebas superadas
- 0 fallos
- 0 snapshots
- Tiempo: 2,532 s

Suites superadas:

- billing.security-spec.ts
- patients-access.security-spec.ts
- portal.security-spec.ts
- messages.security-spec.ts
- notifications.security-spec.ts
- patients-http.security-spec.ts
- billing-http.security-spec.ts
- tasks-workflow.security-spec.ts
- usability-persistence.security-spec.ts
- auth-refresh.security-spec.ts

## 3. Pruebas específicas del Sprint 12

La suite `tasks-workflow.security-spec.ts` valida:

1. El paciente solo puede guardar progreso en una tarea perteneciente a su paciente y workspace.
2. Una tarea ajena no se expone ni se modifica.
3. No se puede enviar una tarea sin respuesta.
4. Una tarea válida pasa a estado `SUBMITTED`.
5. El evento de auditoría no contiene el contenido clínico de la respuesta.

Resultado: **4/4 pruebas superadas**.

## 4. Verificación del frontend

Comando:

```bash
npm --workspace @asepsico/web run typecheck
```

Resultado en la copia extraída: **superado**.

La compilación completa de Next.js no pudo completarse porque el entorno reutilizado carece del paquete transitorio `styled-jsx`. Esto es un problema de instalación de dependencias del entorno y no demuestra un fallo funcional del código.

## 5. Verificación del backend

El typecheck completo del backend no pudo completarse porque faltan dependencias resolubles y el cliente Prisma generado en el entorno de ejecución.

Antes de la validación final local deben ejecutarse:

```bash
npm install
npm run db:generate
npm run db:migrate
npm --workspace @asepsico/api run typecheck
```

## 6. Prueba funcional E2E pendiente en entorno local

Debe validarse el recorrido real siguiente:

### Flujo profesional

1. Iniciar sesión como terapeuta.
2. Abrir la ficha de un paciente asignado.
3. Crear una tarea como borrador.
4. Editar el borrador.
5. Asignar la tarea.
6. Comprobar que aparece en la ficha y en el portal.
7. Revisar una entrega del paciente.
8. Solicitar cambios.
9. Comprobar que el paciente puede volver a editarla.
10. Marcar la tarea como completada.
11. Verificar el evento en la timeline.
12. Cancelar otra tarea y comprobar que se conserva el historial.

### Flujo paciente

1. Iniciar sesión en el portal.
2. Abrir una tarea asignada.
3. Guardar una respuesta parcial.
4. Recargar la página y confirmar persistencia.
5. Intentar enviar una respuesta vacía y comprobar el bloqueo.
6. Enviar una respuesta válida.
7. Confirmar que queda en estado `SUBMITTED`.
8. Ver una solicitud de cambios.
9. Modificar y reenviar.
10. Ver la devolución final del profesional.

### Permisos y seguridad

1. Un administrativo no puede acceder al contenido clínico de la tarea.
2. Un terapeuta no asignado no puede consultar ni modificar la tarea.
3. Un paciente no puede acceder a tareas de otro paciente.
4. No se puede forzar una transición inválida mediante una petición manual.
5. Las notificaciones no incluyen contenido clínico.
6. Los eventos de auditoría no guardan la respuesta del paciente.

## 7. Criterio de aprobación definitivo

El Sprint 12 podrá pasar de BETA a VERIFICADO cuando:

- la migración se aplique sin errores;
- Prisma se genere correctamente;
- frontend y backend superen typecheck;
- la aplicación compile;
- el recorrido profesional-paciente funcione con PostgreSQL real;
- no aparezcan errores críticos o importantes en la prueba manual;
- QA y Code Reviewer emitan aprobación final.
