# Sprint 14 — Exportaciones, backups y preparación para piloto

## Objetivo

Cerrar el ciclo MVP con portabilidad de datos, controles operativos y una puerta de preparación antes de usar AsePsico con usuarios reales.

## Implementado

- Exportación clínica JSON por paciente con control de workspace y terapeuta asignado.
- Exportación administrativa del workspace para OWNER/ADMIN.
- Auditoría de cada exportación sin copiar contenido clínico al log.
- Centro web “Datos y piloto”.
- Checklist de preparación del piloto basado en datos reales.
- Scripts de backup PostgreSQL, checksum, retención y restauración de prueba.
- Runbook operativo de piloto e incidentes.

## Decisiones de seguridad

- No existe exportación pública ni enlace persistente.
- Las descargas se generan bajo sesión autenticada.
- Los terapeutas solo exportan pacientes a los que tienen acceso.
- La exportación administrativa no sustituye al backup de PostgreSQL.
- Los scripts exigen una base aislada para probar restauraciones.

## Fuera de alcance

- Exportación PDF con maquetación clínica.
- Backups gestionados desde la interfaz.
- Almacenamiento cloud automatizado.
- Firma digital de exportaciones.
- Portal de soporte y SLA comercial.
