# Security baseline

Esta entrega es una base de desarrollo reforzada, pero todavía no una certificación para
datos clínicos reales en producción.

## Incluido ahora

- Helmet con Content-Security-Policy explícita (sin `unsafe-inline` en scripts, sin frames).
- Validación estricta de entrada (`whitelist` + `forbidNonWhitelisted`).
- Hash de contraseñas con bcrypt (coste 12) y comparación en tiempo constante también cuando
  el email no existe (evita enumeración de usuarios por timing).
- Sesión basada en cookies `httpOnly` + `SameSite=Lax` (ya no en `localStorage`, invisible a XSS).
- Access token JWT de vida corta (15 min) + refresh token opaco de un solo uso con rotación:
  cada `/auth/refresh` invalida el token anterior y emite uno nuevo. Si un token ya revocado
  se reutiliza (señal de robo/filtración), se revoca toda la familia de sesiones derivadas de
  ese login.
- Protección CSRF con patrón *double-submit cookie* en los endpoints que modifican estado.
- Rate limiting: 5 intentos/minuto en login y registro; 10/minuto en refresh; 100/minuto global.
- Aislamiento por `workspaceId` aplicado tanto en lectura como en las propias operaciones de
  escritura (defensa en profundidad, no solo una comprobación previa).
- Control de acceso por rol a contenido clínico (`ClinicalProcess`): `ASSISTANT` sin acceso;
  `THERAPIST` solo a sus propios procesos; `OWNER`/`ADMIN` a cualquiera. Las vistas generales de
  Patients/Sessions nunca exponen motivo de consulta, objetivos, notas internas ni notas de
  sesión — solo el detalle de cada proceso/sesión, que sí aplica ese control.
- Soft delete y auditoría transaccional para altas, modificaciones y archivado de pacientes.

## Antes de producción (pendiente)

- MFA para las cuentas de terapeutas/administradores.
- Cifrado a nivel de campo para datos clínicos sensibles (motivo de consulta, notas).
- Gestión de secretos (Vault/Secrets Manager) en vez de variables de entorno planas.
- DPA con proveedores, DPIA, política de retención, exportación y borrado de datos (RGPD).
- Backups verificados con pruebas de restauración periódicas.
- SAST/DAST en CI y pruebas de penetración externas antes del primer cliente real.
- Revisión jurídica RGPD / normativa sanitaria aplicable.
- Rotar `JWT_SECRET` mediante un proceso definido y documentar el plan de respuesta a incidentes.
