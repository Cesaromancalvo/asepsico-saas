# Sprint 9 — Ficha clínica unificada

## Objetivo
Convertir la ficha del paciente en el centro operativo del seguimiento terapéutico, reduciendo saltos entre pantallas y mostrando siempre el siguiente paso.

## Implementado
- Nueva vista `Resumen y seguimiento` dentro de `/patients/[id]`.
- Pestaña separada para `Historia clínica`, manteniendo el contenido profesional privado.
- Siguiente acción recomendada según tareas entregadas, tareas pendientes, próxima sesión o ausencia de seguimiento.
- Resumen de próxima sesión, objetivos activos, tareas abiertas y última escala.
- Bloque conjunto de objetivos y tareas.
- Resumen del proceso terapéutico actual.
- Línea temporal reciente.
- Accesos rápidos a plan, tareas, escalas, documentos y portal.
- Diseño adaptable a escritorio y móvil.

## Criterios funcionales
- La ficha responde a: “¿cómo está este paciente y qué debo hacer ahora?”.
- La historia clínica deja de ocupar la pantalla inicial completa.
- Las acciones principales son `Nueva cita` y `Nueva tarea`.
- No se modifica el modelo de permisos ni se expone información al paciente.

## Verificación pendiente
El typecheck no pudo ejecutarse en el contenedor porque esta copia no contiene `node_modules`. Debe verificarse localmente tras `npm install` con:

```bash
npm --workspace @asepsico/web run typecheck
npm --workspace @asepsico/api run test:security
```
