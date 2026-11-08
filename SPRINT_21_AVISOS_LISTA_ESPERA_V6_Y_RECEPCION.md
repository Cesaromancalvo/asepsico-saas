# Sprint 21 — Avisos al equipo, lista de espera v6, privacidad de la web y recepción sin datos del proceso clínico (02–08/11/2026)

## Objetivo

Preparar el piloto demo (solo datos inventados) para las primeras demostraciones y contactos:

1. **Avisar dentro de la app al equipo** cuando cambia una cita (campana y bloque «Cambios de agenda»), sin correo ni SMS.
2. **Lista de espera v6:** que quien se apunta elija cómo quiere que le contacten y que el teléfono sea opcional.
3. **Web pública:** explicar en `/privacidad/` los contactos que inicia el proyecto y mejorar la conversión de la landing.
4. **Recepción (`ASSISTANT`) sin metadatos del proceso clínico** en agenda, citas y fichas de pacientes (regla dura 2).

Este documento registra lo fusionado en `main` del 02 al 08/11/2026 con los PR #54 a #60 (HEAD `18dcec7`). El PR #53 (03/11) es el propio documento del Sprint 20. No declara nada como validado para datos clínicos reales.

## Qué incluye

### PR #54 y #55 — Avisos en la app al personal cuando cambia una cita (merges `93f9784` y `467b1fa`, 03/11/2026)

**API (#54)** — contrato en `docs/STAFF_NOTIFICATIONS_API.md`.

- Aviso al profesional cuando recepción, `OWNER` o `ADMIN` mueven o cancelan su cita, y cuando otra persona aprueba o rechaza una solicitud del portal. Cuando el paciente pide desde el portal cambiar o cancelar (o retira la petición), se avisa al profesional y a `OWNER`, `ADMIN` y recepción. Nunca se avisa a quien hace el cambio.
- `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read` y `POST /notifications/read-all`, acotados a `workspaceId` y destinatario.
- Lo guardado es genérico (sin nombre ni fecha); el nombre y la fecha se componen al leer con el acceso de agenda de quien lee. Respuesta con lista blanca. Sin migración: reutiliza `Notification` con audiencia `PROFESSIONAL`.
- Cerrar una sesión pasa a ser transaccional (estado, auditoría y aviso juntos).
- Condiciones de la revisión de seguridad (`597610b`): regla escrita de que un envío externo futuro solo usará el título y el cuerpo guardados, nunca los metadatos; tests de cambio de rol, de *rollback* del cierre si falla el aviso (PostgreSQL real) y de que el portal nunca devuelve avisos del personal. Retención y purga de estos avisos, anotadas como pendientes.
- CI: la suite `appointment-change-notices-db` corre en `postgres-integration` con base de datos obligatoria y `test:ci-config` la exige (`b1c9b25`).

**Web (#55)**

- Campana con contador de no leídos en la barra lateral (y barra superior propia en el móvil), desplegable con los últimos avisos y «Marcar todos como leídos». Pulsar un aviso de cita lleva a la agenda en la semana de la cita y la resalta; la cita a resaltar se pasa en memoria (nada en la URL ni en `localStorage`).
- Bloque «Cambios de agenda» en «Mi jornada» (clínica y de recepción).
- Portal del paciente: los avisos sin leer («Tu cita ha cambiado») aparecen arriba.
- Test de componente de la campana (`apps/web/test/notification-bell.spec.tsx`).

### PR #56 — `/privacidad/` §3.3: contactos que iniciamos (merge `da62a55`, 05/11/2026)

Apartado 3.3 de la política de privacidad de la web con el texto redactado por Lex Psi (asistente legal de IA del equipo) sobre los contactos que inicia el proyecto con entidades y cuentas profesionales y las demostraciones pedidas por email o Instagram: datos, origen, finalidad, base jurídica, conservación, destinatarios y derecho de oposición destacado.

### PR #57 — Mejoras de conversión de la landing (merge `abcf6eb`, 05/11/2026)

- Bloques «Quiénes somos» y «Qué pasa después de apuntarte» junto al formulario; JSON-LD alineado.
- «¿Qué usas hoy?» con opciones genéricas, sin nombres de programas de terceros; preguntas opcionales plegadas.
- Recurso descargable **«Mapa de tu semana de consulta»** (PDF de 2 páginas en `/recursos/mapa-semana-consulta/`), con el contenido también en texto y descarga directa **sin pedir email**. PDF sin JavaScript, formularios ni enlaces, con metadatos limpios; `check-landing` comprueba los PDF publicados.

### PR #58 — Lista de espera v6: preferencia de contacto y teléfono opcional (merge `8943229`, 07/11/2026)

- **Migración 40** (`20261105184816_waitlist_contact_preference`): enum `WaitlistContactPreference` (`PHONE_AND_EMAIL` / `EMAIL_ONLY`) y columna `contactPreference`, con relleno de las filas activas (con teléfono → `PHONE_AND_EMAIL`; sin él → `EMAIL_ONLY`; suprimidas → `NULL`).
- Alta `lista-espera-v6`: preferencia obligatoria, **sin opción marcada por defecto** en el formulario. Con `PHONE_AND_EMAIL` el teléfono es obligatorio (E.164, cifrado); con `EMAIL_ONLY` cualquier teléfono → 400 `WAITLIST_PHONE_NOT_ALLOWED` (la landing oculta, vacía y no envía el campo).
- **Transición de la v5** solo mientras lo permita `WAITLIST_V5_ACCEPTED_UNTIL` (máximo 7 días; sin la variable, retirada), fijada en producción hasta el **12/11/2026 a las 23:59 (hora peninsular)**. v1–v4 siguen retiradas.
- Borrar el teléfono (panel o CLI) deja la preferencia en `EMAIL_ONLY`; nada de esto va a logs ni auditoría.
- Política `lista-espera-v6` en `/privacidad-lista-espera/` y la v5 archivada en `/privacidad-lista-espera/v5/` con `noindex`.
- Condiciones de la revisión de seguridad (`875ef2e`): borrar el teléfono de una fila que ya no lo tiene no escribe ni audita; orden de despliegue y comprobación de solo lectura en `ops/PILOT_RUNBOOK.md`; smoke HTTP real con las dos preferencias, v6 sin preferencia y la v5 fuera y dentro de plazo.
- Contrato al día en `docs/WAITLIST_API.md`.

### PR #59 — Recepción sin datos del proceso clínico en agenda, citas y fichas (merge `c71000f`, 07/11/2026)

- **Agenda y citas** (`GET /sessions`, `GET /sessions/:id`, agenda del paciente y respuestas de crear, mover, cancelar y cerrar): para recepción, sin modalidad, estado, frecuencia ni id del proceso; solo el booleano `hasClinicalProcess`.
- **Pacientes** (`GET /patients`, `GET /patients/:id`, `PATCH /patients/:id`): solo el proceso **activo** del espacio con su id, el profesional (sin email) y `hasActiveProcess`; sin estado, modalidad, frecuencia, fechas, recuento de procesos ni procesos de alta o cerrados. Tampoco el `clinicalProcessId` de las citas de la ficha, que permitía deducir procesos anteriores.
- La vista de recepción se elige en la propia consulta y falla en cerrado para cualquier rol que no sea `OWNER`, `ADMIN` o `THERAPIST`; esos tres roles no cambian.
- Deuda multi-tenant baja corregida: la relación `sessions` de la ficha filtra también por `workspaceId`.
- Web: agenda, listado, ficha y seguimiento funcionan con los booleanos; recepción no ve el enlace «Abrir proceso».
- **Smoke 9b:** el smoke HTTP real comprueba con un `ASSISTANT` y datos ficticios en dos consultas propias lo que ve recepción (incluido 403 en `GET /clinical-processes/:id` y 404 para un paciente de otra consulta) y que `OWNER` conserva sus campos. `test:ci-config` exige el paso.
- Sin migraciones.

### PR #60 — `/privacidad/` §3.3 con Instagram, WhatsApp, LinkedIn y contactos presentados (merge `18dcec7`, 07/11/2026)

Amplía el apartado 3.3 con los textos de Lex Psi: contactos por LinkedIn y WhatsApp, profesionales que presenta una persona que los conoce (tras preguntarles) y personas conocidas personalmente; tratamiento por Meta y LinkedIn según sus propias políticas; conservación del nombre de la entidad en la lista de no contactar. Última actualización y `lastmod` del sitemap al 07/11/2026.

### Operación (fuera del código)

- **07/11/2026:** la API del piloto demo pasa a un plan de pago de Render para que no se suspenda por inactividad (requisito de los avisos por email que vienen). Comprobado `/health` 200 tras el cambio; queda repetir la comprobación tras un rato sin tráfico.
- **07/11/2026:** publicación de la v6 con copia previa de la base de datos, ensayo de la migración 40 sobre una copia restaurada y migración aplicada a mano en producción antes del merge, según el runbook. El registro detallado vive fuera del repositorio.

## Seguridad

- **Regla dura 2 (contenido clínico por rol):** #59 cierra la exposición de metadatos del proceso clínico a recepción, que existía en `main` antes de esta semana. Cada commit trae tests que fallan sin el cambio.
- **Multi-tenant:** los avisos filtran por `workspaceId` y destinatario; la ficha filtra las citas por `workspaceId` también en la relación.
- **Sin canal externo:** los avisos de esta semana viven solo en la app y en el portal; no se envía correo ni SMS. El envío por email al equipo está en una rama aparte (ver Pendiente).
- **Lista de espera:** preferencia sin valor por defecto, teléfono solo con consentimiento para llamadas, cifrado en reposo y fuera de logs y auditoría.
- **Revisión de seguridad (Argos):** aprobada en #54 (con condiciones incorporadas en `597610b`), #55 (parte web), #58 (condiciones en `875ef2e`) y #59 (los cinco commits). #56, #57 y #60 son cambios de la web estática con textos de Lex Psi; no consta revisión de seguridad específica.
- **Textos legales:** los apartados de privacidad son redacción de un asistente de IA; **no** han pasado por un abogado humano.
- Sin datos reales en código, tests ni seeds.

## Decisiones técnicas

- **Avisos sin migración**, reutilizando `Notification` con audiencia `PROFESSIONAL`, y **texto guardado genérico**: el nombre y la fecha se componen al leer con los permisos de quien lee, así un cambio de rol no deja ver lo que ya no corresponde.
- **v5 en transición con fecha tope por variable de entorno** (máximo 7 días) en lugar de cortar en seco: protege a quien tiene la página antigua en caché.
- **Migración 40 aplicada a mano antes del merge**: Render no ejecuta migraciones al desplegar.
- **Booleanos `hasClinicalProcess` / `hasActiveProcess` para recepción:** Prisma no deriva un booleano de una clave foránea en el `select`, así que el id se lee internamente y la respuesta se proyecta con lista blanca sin él.
- **Recurso PDF sin pedir email**: no añade un tratamiento de datos nuevo.

## Evidencia

- **Cifras de tests (Quima):**
  - #54: typecheck, `test:security` sin fallos, integración con base de datos real **80/80** y build (descripción del PR).
  - #55: tests de web **271/271**, `test:security`, integración **80/80** y build (descripción del PR).
  - #58: typecheck, **1721** tests de seguridad, comprobaciones de la landing y build en verde el 06/11; los tests con base de datos, en el CI del PR.
  - #56, #57, #59 y #60: sin recuentos aportados. #59 queda cubierto por sus tests nuevos y el smoke 9b en el CI.
- **CI (consulta a la API pública de GitHub, 08/11/2026):** los dos checks (`Typecheck, tests and build` y `PostgreSQL migrations and real HTTP smoke test`) en verde en el último commit de cada PR (`b1c9b25`, `b9385c7`, `5d62fae`, `22e53ad`, `27d6d05`, `cfc21c8`, `2c8af6e`) y en los merges `467b1fa`, `da62a55`, `abcf6eb`, `8943229`, `c71000f` y `18dcec7`. En el merge `93f9784` las ejecuciones aparecen canceladas (sustituidas por la del merge `467b1fa`, 17 s después).
- **Producción (comunicado; registro fuera del repositorio):**
  - 03/11: `GET /notifications` sin sesión responde 401 (ruta desplegada).
  - 05/11: `/privacidad/` con el apartado 3.3; «Quiénes somos», «Qué pasa después» y el PDF del mapa responden 200.
  - 07/11: migración 40 aplicada; v6 sin preferencia → `WAITLIST_CONTACT_PREFERENCE_REQUIRED`; v6 «Solo por email» con teléfono → `WAITLIST_PHONE_NOT_ALLOWED`; v5 sin teléfono → `WAITLIST_PHONE_REQUIRED` (transición abierta); formulario con las dos opciones y ninguna marcada; v5 archivada con `noindex`.
  - 07/11: tras #59, `/health` 200 y web redesplegada. No se ha comprobado en producción con una cuenta de recepción.
  - 08/11: `/privacidad/` menciona LinkedIn.

## Pendiente

- **13/11/2026 (paso 14 de la publicación de la v6):** quitar `WAITLIST_V5_ACCEPTED_UNTIL` en Render y retirar la v5 en el código (después, v5 → `WAITLIST_POLICY_VERSION_RETIRED`).
- **Emails al equipo y privacidad `demo-1.3`:** en la rama `feat/email-staff-web`, sin fusionar; publicación prevista el 09/11/2026. Hasta entonces la privacidad para profesionales vigente en `main` es `demo-1.2`. Riesgos aceptados para el equipo y abiertos antes de encender los emails a pacientes:
  - **B2:** envío «al menos una vez»: si la API cae justo después de enviar, el mismo aviso puede llegar dos veces a la misma persona (nunca a otra ni con otro contenido).
  - **B4:** retención de entregas de email y avisos del equipo: sin purga todavía (propuesta: 90 días).
- **Agenda de recepción:** pendiente el filtro de la agenda para recepción y el comportamiento cuando la vista tiene más de 100 citas.
- **Importación de pacientes:** existe en la API (`apps/api/src/patient-import/`), pero no tiene pantalla en la web.
- **Avisos al personal:** retención de 90 días y borrado ligado a la futura supresión del paciente, sin implementar (`docs/STAFF_NOTIFICATIONS_API.md`).
- **Producción:** comprobar con una cuenta de recepción del entorno demo que la agenda y la ficha no muestran datos del proceso; comprobar la campana con un cambio de cita real en el entorno demo.
- **Antes del primer paciente real:** revisión por abogado de los textos legales (incluidos los apartados nuevos de `/privacidad/`), riesgo M1 de `TRUST_PROXY` y el resto de la Fase B del roadmap.

## Criterio de aprobación

La entrega queda **Implementada** en `main` con el CI en verde en `18dcec7`. Pasará a validada para el piloto demo cuando conste por escrito:

- en producción, una cuenta `ASSISTANT` del entorno demo que ve la agenda y la ficha sin estado, modalidad ni id del proceso, y recibe 403 en `GET /clinical-processes/:id`;
- un cambio de cita en el entorno demo que genera el aviso en la campana del profesional y no en la de quien lo hace;
- una alta v6 «Solo por email» sin teléfono guardada y, tras el 13/11, una alta v5 respondiendo `WAITLIST_POLICY_VERSION_RETIRED`.
