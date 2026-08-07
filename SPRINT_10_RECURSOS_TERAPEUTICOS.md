# Sprint 10 · Recursos terapéuticos

## Objetivo funcional

Centralizar materiales reutilizables y controlar qué ve cada paciente, sin enviar enlaces o archivos por canales dispersos.

## Incluido

- Biblioteca por workspace de enlaces y metadatos de archivos.
- Categorías: psicoeducación, ejercicio, hoja de trabajo, audio, vídeo, lectura y otros.
- Alta, edición y archivo lógico de recursos.
- Compartir y retirar acceso por paciente.
- Visualización inmediata en el portal del paciente.
- Integración desde la ficha clínica unificada.
- Aislamiento por workspace, acceso clínico del terapeuta y bloqueo para asistentes.
- Auditoría de creación, edición, archivo, compartición y retirada.
- Migración Prisma versionada.

## Decisión técnica sobre archivos

El sprint registra metadatos y `storageKey`, pero no simula una subida binaria inexistente. La carga privada, URLs temporales, antivirus y límites se conectarán a MinIO antes del piloto. Los enlaces sí son utilizables de extremo a extremo.

## Flujo principal

Ficha del paciente → Recursos → Crear o seleccionar material → Compartir → Portal del paciente → Retirar cuando deje de ser necesario.

## Criterios de aceptación

1. Un recurso se crea una vez y puede reutilizarse.
2. Un paciente solo ve recursos activamente compartidos con él.
3. Retirar acceso lo elimina del portal sin borrar el recurso de la biblioteca.
4. Archivar un recurso revoca sus comparticiones activas.
5. Ningún workspace puede consultar o compartir recursos de otro.
