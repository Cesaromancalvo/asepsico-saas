# Recuperar la contraseña del portal del paciente

- **Autora:** Vega (producto)
- **Fecha:** 30/09/2026
- **Estado:** LISTA PARA DESARROLLO (Bruno y Fina). Revisión de Argos obligatoria (toca `portal` y
  `auth`).
- **Depende de:** el envío de emails al paciente (proveedor de email, bandeja de salida y textos
  neutros) y, si ya existe, la infraestructura de enlaces de un solo uso de la invitación al portal.
  Sin email en funcionamiento esta funcionalidad no se puede liberar.
- **Modelo actual:** cada cuenta de portal (`PatientPortalAccount`) es de una persona (paciente o
  tutor), tiene **su propio email, único en todo el sistema**, y su propia contraseña. El inicio de
  sesión ya bloquea la cuenta 15 minutos tras 5 fallos.

---

## 1. Problema y usuario

- **Quién:** el paciente (o su tutor) que ha olvidado la contraseña del portal.
- **Cuándo:** entre sesiones, desde el móvil, cuando quiere entregar una tarea o leer un mensaje.
- **Cuánto duele:** hoy tiene que pedirle a su psicóloga una contraseña nueva, que esta le pasa por
  otro canal. Retrasa la tarea, carga a la psicóloga y es inseguro. Si el paciente no puede entrar,
  el seguimiento entre sesiones se para.

## 2. Historias de usuario

- **H1.** Como paciente quiero pedir un enlace para crear una contraseña nueva, para volver a entrar
  sin depender de mi psicóloga.
- **H2.** Como tutor de un menor quiero recuperar **mi** contraseña sin afectar a la cuenta del menor
  ni a la de otro tutor.
- **H3.** Como psicóloga quiero poder enviar a mi paciente el enlace de recuperación desde su ficha,
  sin conocer nunca su contraseña.

## 3. Flujo

1. En la pantalla de acceso al portal, enlace **"¿Has olvidado tu contraseña?"**.
2. El usuario escribe su email y pulsa "Enviar enlace".
3. **Siempre** ve el mismo mensaje: "Si hay una cuenta con ese email, te hemos enviado un enlace para
   crear una contraseña nueva. Revisa también la carpeta de spam. El enlace caduca en 60 minutos."
4. Si la cuenta existe y puede recibir el enlace (apartado 4), se envía un email **neutro**:
   - Asunto: "Crea una contraseña nueva".
   - Remitente: el que haya elegido la consulta (su nombre o el genérico), con el dominio neutro de
     envío.
   - Cuerpo: texto breve con el botón "Crear contraseña nueva", la caducidad y "Si no lo has pedido
     tú, ignora este mensaje: tu contraseña no cambiará." **Sin** nombre del profesional (salvo que
     la consulta lo haya elegido como remitente), sin "psicología", "terapia" ni ningún dato clínico.
5. El enlace abre la pantalla "Crea tu contraseña nueva" (dos campos, mismas reglas de contraseña que
   el cambio de contraseña actual del portal).
6. Al guardarla: mensaje "Contraseña cambiada. Ya puedes entrar." y email de aviso "Tu contraseña se
   ha cambiado. Si no has sido tú, contacta con tu consulta."

## 4. Reglas

| Aspecto | Regla |
|---|---|
| Token | Aleatorio de alta entropía (al menos 32 bytes), **de un solo uso**. En la base de datos solo se guarda su **hash**, con la cuenta, el workspace, la fecha de creación y la de caducidad |
| Caducidad | **60 minutos** |
| Tokens anteriores | Pedir uno nuevo invalida los anteriores de esa cuenta. Cambiar la contraseña invalida todos |
| Quién puede recibirlo | Cuenta **activa** (`isActive = true`), de un paciente que no esté bloqueado ni archivado, en un workspace activo. Si no se cumple, **no se envía nada** y la respuesta es la misma |
| No revelar si el email existe | Misma respuesta, mismo código HTTP y **tiempo de respuesta similar** exista o no la cuenta (el envío del email va a la bandeja de salida, no en la petición) |
| Límite de solicitudes | Por email: **3 por hora**. Por IP: **10 por hora**. Por encima, misma respuesta genérica y no se envía nada (ni se revela que se ha alcanzado el límite para ese email) |
| Límite al confirmar | Un token admite **5 intentos** de guardar contraseña (por ejemplo, contraseñas que no cumplen las reglas); después queda invalidado |
| Al cambiar la contraseña | `mustChangePassword = false`, `failedLoginAttempts = 0`, `lockedUntil = null`, y **se cierran todas las sesiones abiertas** de esa cuenta en el portal |
| Token en la URL | En el fragmento (`#`) o enviado por POST desde la página, nunca en logs de acceso; la página usa `Referrer-Policy: no-referrer` y no carga recursos de terceros |
| Cuenta bloqueada por intentos | Recuperar la contraseña desbloquea la cuenta al guardarla (no antes) |

## 5. Tutores y modo de acceso

- Cada persona recupera **solo su propia cuenta**, identificada por su email. Como los emails de
  cuenta son únicos, no hay ambigüedad.
- **PATIENT_ONLY:** solo existe la cuenta del paciente; recupera la suya.
- **GUARDIAN_ONLY:** solo existen cuentas de tutores; cada tutor recupera la suya. Si el menor
  intentara recuperar con un email que no tiene cuenta, recibe la respuesta genérica y no pasa nada.
- **SHARED:** paciente y tutores tienen cuentas independientes. Recuperar la contraseña de una **no
  cambia ni cierra las sesiones de las demás**, ni avisa a las demás.
- Si la consulta cambia el modo de acceso y una cuenta queda desactivada, esa cuenta **no puede
  recuperar la contraseña** (respuesta genérica, sin envío). Los tokens pendientes de esa cuenta se
  invalidan al desactivarla.
- Limitación conocida (fuera de alcance): un tutor con dos hijos pacientes necesita hoy un email por
  cuenta, porque el email es único.

## 6. Desde la ficha del paciente (H3)

- En la gestión de cuentas de portal del paciente, botón **"Enviar enlace para crear contraseña
  nueva"** junto a cada cuenta.
- Pueden usarlo los mismos roles que hoy gestionan las cuentas de portal de ese paciente (con el
  modelo de acceso por proceso: su profesional; la dirección y la recepción, como operación
  administrativa, si la gestión de cuentas se considera administrativa — Argos lo confirma).
- El profesional **nunca** ve ni fija la contraseña. Se envía el mismo email del apartado 3 y cuenta
  para el límite de solicitudes.
- Se audita como `PORTAL_PASSWORD_RESET_SENT_BY_STAFF` (quién, qué cuenta).

## 7. Auditoría y logs

| Evento | Cuándo | Metadatos (nunca email en claro, token ni contraseña) |
|---|---|---|
| `PORTAL_PASSWORD_RESET_REQUESTED` | Solicitud válida sobre una cuenta que existe y puede recibirlo | id de la cuenta, tipo (paciente o tutor), origen (portal o ficha) |
| `PORTAL_PASSWORD_RESET_COMPLETED` | Contraseña cambiada con un token | id de la cuenta; sesiones cerradas (número) |
| `PORTAL_PASSWORD_RESET_TOKEN_REJECTED` | Token caducado, usado o agotado | id de la cuenta si se conoce; motivo |
| Solicitudes sobre emails inexistentes o por encima del límite | — | **No** se auditan en el workspace (no hay workspace). Solo un contador técnico sin el email, para detectar abusos |

Toda auditoría va en la misma transacción que el cambio al que se refiere.

## 8. Criterios de aceptación

**Solicitud**
- Dado un email con cuenta de portal activa, cuando se pide el enlace, entonces se responde con el
  mensaje genérico y se encola un email neutro con un enlace que caduca en 60 minutos.
- Dado un email sin cuenta, cuando se pide el enlace, entonces la respuesta es idéntica (texto, código
  HTTP y tiempo similar) y no se envía nada.
- Dada una cuenta desactivada, o de un paciente bloqueado o archivado, cuando se pide el enlace,
  entonces la respuesta es la genérica y no se envía nada.
- Dadas 4 solicitudes en una hora para el mismo email, cuando llega la cuarta, entonces la respuesta
  es la genérica y no se envía un cuarto email.
- Dado cualquier email enviado, cuando se revisa, entonces no contiene datos clínicos, ni
  "psicología" o "terapia", ni el nombre del profesional salvo que sea el remitente elegido por la
  consulta.

**Token**
- Dado un enlace usado, cuando se abre de nuevo, entonces no permite cambiar la contraseña y ofrece
  pedir uno nuevo.
- Dado un enlace de hace más de 60 minutos, cuando se abre, entonces está caducado.
- Dados dos enlaces pedidos seguidos, cuando se usa el primero, entonces no funciona (solo vale el
  último).
- Dado un token, cuando se inspecciona la base de datos, entonces solo está su hash.
- Dados 5 intentos fallidos de guardar contraseña con el mismo token, cuando llega el sexto, entonces
  el token está invalidado.

**Cambio**
- Dado un token válido y una contraseña que cumple las reglas, cuando se guarda, entonces la cuenta
  queda con la nueva contraseña, desbloqueada, sin obligación de cambiarla, y todas sus sesiones
  abiertas del portal se cierran.
- Dado el cambio, cuando se completa, entonces se envía el email de aviso y queda auditado.
- Dado un paciente en modo SHARED que recupera su contraseña, cuando la cambia, entonces las cuentas
  de sus tutores siguen igual y con sus sesiones abiertas.

**Desde la ficha**
- Dado el profesional del paciente, cuando pulsa "Enviar enlace…", entonces se envía el mismo email,
  queda auditado y el profesional no ve ni puede fijar la contraseña.
- Dado un usuario sin permiso sobre las cuentas de portal de ese paciente, cuando llama al endpoint,
  entonces recibe 403.
- Dada cualquier operación, cuando se ejecuta, entonces filtra por el `workspaceId` de la cuenta.

## 9. Para Argos (revisión obligatoria)

1. No enumeración de cuentas: misma respuesta, código y tiempo; envío asíncrono.
2. Token: entropía, solo hash en la base de datos, un solo uso, caducidad, invalidación de los
   anteriores y al desactivar la cuenta.
3. Token fuera de logs, del `Referer` y de herramientas de terceros.
4. Límites por email y por IP (detrás del proxy de confianza ya configurado) e intentos por token.
5. Cierre de sesiones del portal al cambiar la contraseña: confirmar el mecanismo con los tokens
   actuales del portal (si no son revocables, añadir una versión de credenciales en la cuenta).
6. Textos y cabeceras del email: neutros, sin datos clínicos, coherentes con el remitente elegido
   por la consulta.
7. Aislamiento entre cuentas de un mismo paciente en modo SHARED.
8. Quién puede enviar el enlace desde la ficha con el modelo de acceso por proceso.
9. Protección CSRF en la confirmación, igual que el resto de acciones del portal.

## 10. Fuera de alcance

Recuperación de contraseña de profesionales (se hace por procedimiento del equipo, con MFA);
recuperación por SMS; preguntas de seguridad; cambio del email de la cuenta; cuentas de portal con
un mismo email para varios pacientes.
