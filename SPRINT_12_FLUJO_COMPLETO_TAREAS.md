# Sprint 12 · Flujo completo de tareas terapéuticas

## Objetivo
Convertir las tareas en un flujo clínico completo entre profesional y paciente, manteniendo al profesional como responsable del cierre.

## Flujo implementado

`DRAFT → PENDING → IN_PROGRESS → SUBMITTED → COMPLETED`

Ramas controladas:

- `SUBMITTED → CHANGES_REQUESTED → IN_PROGRESS → SUBMITTED`
- cualquier tarea activa puede cancelarse;
- una tarea completada puede reabrirse;
- solo los borradores pueden eliminarse físicamente.

## Área profesional

- creación personalizada;
- guardado como borrador;
- asignación al paciente;
- biblioteca reutilizable de plantillas;
- filtros por estado;
- revisión de la respuesta;
- devolución profesional;
- solicitud de cambios;
- cierre profesional;
- notas clínicas privadas.

## Portal del paciente

- lectura de instrucciones;
- guardado de progreso;
- entrega para revisión;
- consulta de devoluciones;
- nueva edición cuando se solicitan cambios;
- lenguaje no punitivo y fechas orientativas.

## Seguridad

- las operaciones del portal filtran por paciente y workspace;
- el paciente no puede completar ni cancelar tareas;
- el backend controla las transiciones;
- las notas clínicas no se devuelven al portal;
- los eventos de auditoría no incluyen la respuesta clínica.

## Base de datos

- ampliación de estados;
- fechas de asignación, inicio, entrega y revisión;
- devolución profesional separada de la nota clínica;
- nueva entidad `TherapeuticTaskTemplate` aislada por workspace;
- migración compatible con tareas existentes.

## Fuera de alcance

- adjuntos;
- recurrencia;
- gamificación;
- evaluación automática mediante IA;
- interpretación clínica automática.
