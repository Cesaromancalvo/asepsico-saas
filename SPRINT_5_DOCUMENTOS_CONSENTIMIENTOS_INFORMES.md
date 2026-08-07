# Sprint 5 — Documentos, consentimientos e informes

## Alcance implementado

- Registro documental por paciente con metadatos, tipo, nombre de archivo, MIME y referencia privada de almacenamiento.
- Consentimientos con tipo, estado, firmante, fechas y notas.
- Transición de consentimientos pendientes a firmados.
- Informes clínicos en borrador o finales.
- Protección de trazabilidad: un informe final no se elimina ni se reescribe; solo puede anularse.
- Protección de trazabilidad en consentimientos firmados, revocados o caducados.
- Integración en la línea temporal clínica.
- Nueva pantalla `/patients/[id]/documents`.
- Auditoría sin copiar contenido narrativo sensible al log.

## Seguridad

- Acceso restringido a OWNER, ADMIN y THERAPIST.
- THERAPIST solo accede a pacientes con proceso clínico asignado.
- Todas las consultas y mutaciones quedan delimitadas por `workspaceId` y `patientId`.
- ASSISTANT no accede a documentos, consentimientos ni informes clínicos.
- Pacientes archivados quedan en modo no editable.
- La aplicación no almacena binarios en la base de datos. `storageKey` es solo una referencia a almacenamiento privado externo.

## Pruebas añadidas

Se añadieron pruebas de regresión para:

- bloqueo de ASSISTANT;
- aislamiento de documentos por workspace y paciente;
- prohibición de eliminar informes finales;
- auditoría documental sin contenido narrativo.

## Verificación realizada en el entorno de entrega

- Comprobación sintáctica/transpilación de 8 archivos TypeScript/TSX modificados: superada.
- Revisión de migración y rutas: realizada.
- Integridad del ZIP: comprobar tras generar.

## Validación local requerida

```bash
npm install
npm run db:generate
npm run db:migrate
npm run typecheck
npm --workspace @asepsico/api run test:security
npm run dev:api
npm run dev:web
```

La suite completa no pudo ejecutarse en el entorno de entrega porque la instalación de dependencias agotó el tiempo de red.
