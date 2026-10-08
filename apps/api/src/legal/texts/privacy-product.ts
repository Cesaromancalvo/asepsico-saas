// Texto de Lex Psi (privacidad-profesionales-demo-v1.md, demo-1.1): SOLO lo que va entre INICIO/FIN TEXTO CARGABLE.
// BORRADOR pendiente de revisión por abogado humano. Rellenados en git: email de contacto, ciudad y
// fechas. [NIF] y [DOMICILIO] NO se rellenan aquí (el repositorio es público): los sustituye el
// despliegue con LEGAL_TITULAR_NIF y LEGAL_TITULAR_DOMICILIO (ver legal-documents.ts). Mientras
// quede algún marcador [XXX], el documento es borrador y en producción da 503 LEGAL_TERMS_DRAFT.
// Cualquier cambio del texto cambia el hash y obliga a aceptarlo de nuevo: sube también la versión.
export const PRIVACY_PRODUCT_TEXT = `# Política de privacidad para profesionales del piloto demo de AsePsico

Versión demo-1.1 · En vigor desde el 17/10/2026

Esta política explica cómo tratamos los datos de las **personas profesionales** (titulares de un
espacio y miembros de su equipo) que participan en el **piloto demo** de AsePsico. En el piloto demo
no debe haber datos de pacientes reales: solo datos inventados (condiciones de uso, apartado 4).

## 1. Responsable

- **Responsable:** César Román Calvo, persona física, que desarrolla el proyecto AsePsico.
- **NIF:** [NIF]
- **Domicilio:** [DOMICILIO]
- **Contacto, también para privacidad:** asepsico1@gmail.com

No hemos designado delegado de protección de datos porque, por el tipo y el volumen de datos de esta
prueba, no es obligatorio.

## 2. Qué datos tratamos

- **Identificación y contacto:** nombre, apellidos y email; nombre de tu consulta o espacio; tu rol
  en el espacio y si atiendes pacientes (sí o no).
- **Acceso y seguridad:** tu contraseña (solo guardamos una versión cifrada que no permite
  recuperarla), los datos de la verificación en dos pasos, tus sesiones, y la dirección IP y el
  navegador desde los que te registras, inicias sesión o aceptas las condiciones; y un registro de
  las acciones relevantes en tu cuenta y tu espacio.
- **Prueba de la aceptación:** qué versión de las condiciones y de esta política aceptaste o se te
  mostró, su huella digital, la fecha y hora, la IP y el navegador.
- **Comunicaciones:** los emails que intercambiemos, tus comentarios sobre AsePsico y, si la haces,
  las notas de la llamada de seguimiento.

**No te pedimos número de colegiado ni ningún dato de salud.**

Si te ha invitado otra persona de tu consulta, tu nombre y tu email nos los ha facilitado ella al
invitarte.

Los datos marcados como obligatorios en el registro (nombre, apellidos, email y contraseña) son
necesarios para crear la cuenta; sin ellos no puedes participar.

## 3. Para qué y con qué base jurídica

| Para qué | Base jurídica |
|---|---|
| Si eres miembro invitado: enviarte la invitación de tu consulta para unirte a su espacio | Interés legítimo nuestro y de tu consulta en que puedas unirte a su espacio (art. 6.1.f RGPD) |
| Crear y gestionar tu cuenta y tu espacio, prestarte el piloto demo, darte soporte y enviarte avisos del servicio (cambios, incidencias, fin de la prueba) | Ejecución de las condiciones de uso que aceptas, como titular o como miembro invitado (art. 6.1.b RGPD) |
| Proteger el servicio: verificación en dos pasos, registro de actividad, prevención de abusos e investigación de incidentes | Interés legítimo en mantener seguro el servicio y a quienes lo usan (art. 6.1.f) |
| Conservar la prueba de que aceptaste las condiciones y defendernos ante reclamaciones | Interés legítimo (art. 6.1.f) |
| Analizar tus comentarios para mejorar AsePsico | Interés legítimo en mejorar el producto (art. 6.1.f) |
| Al terminar, proponerte por email participar en el piloto con pacientes reales | Interés legítimo (art. 6.1.f) y art. 21.2 de la Ley 34/2002. Puedes decir que no en cualquier momento y en cada email |
| Atender requerimientos de autoridades o jueces | Obligación legal (art. 6.1.c) |

Cuando usamos el interés legítimo, hemos valorado que son tratamientos que esperas al usar un
servicio de prueba, que afectan solo a datos profesionales básicos y que puedes oponerte
(apartado 7).

No usamos tus datos para publicidad de terceros, no los vendemos y no publicamos tu nombre ni tu
opinión sin tu consentimiento expreso, que te pediríamos aparte.

## 4. Cuánto tiempo los conservamos

- **Cuenta y contenido del espacio:** mientras dure el piloto demo. Se suprimen en un plazo máximo
  de 30 días desde el fin de la prueba o desde tu baja.
- **Prueba de la aceptación y registro de actividad:** se conservan **bloqueados** (sin uso, solo
  para atender reclamaciones o requerimientos de autoridades) durante 3 años desde el fin de la
  prueba o tu baja, y después se suprimen.
- **Emails de soporte y comentarios:** hasta 12 meses desde la última comunicación. Podemos
  conservar los comentarios después, sin datos que te identifiquen.
- **Registros técnicos de los proveedores de alojamiento:** el plazo breve que fija cada proveedor
  para su funcionamiento y seguridad.

## 5. Quién más trata tus datos

No cedemos tus datos a terceros, salvo obligación legal. Estos proveedores nos prestan servicios
para que AsePsico funcione:

- **Render Services, Inc. (Estados Unidos):** servidor de la aplicación y base de datos, alojados en
  su región de Frankfurt (Alemania). Usa a su vez proveedores con sede en Estados Unidos. Trata los
  datos con un acuerdo de tratamiento de datos que incluye las cláusulas contractuales tipo de la
  Comisión Europea.
- **Vercel Inc. (Estados Unidos):** aloja la parte web de la aplicación y hace llegar tus peticiones
  al servidor, por lo que tus datos de acceso pasan por su infraestructura, que puede estar en
  Estados Unidos y en otros países.
- **Google (Gmail):** correo electrónico de AsePsico, para los emails de soporte y de la prueba.
- Si la llamada de seguimiento se hace por videollamada, el proveedor que te indiquemos al
  proponértela.

## 6. Transferencias fuera del Espacio Económico Europeo

Render Services, Inc., Vercel Inc. y Google LLC están adheridas al Marco de Privacidad de Datos
UE-EE. UU., que la Comisión Europea reconoce como garantía adecuada (Decisión de Ejecución (UE)
2023/1795). En el caso de Render, además, mediante las cláusulas contractuales tipo de la Comisión
Europea. Puedes pedirnos más información sobre estas garantías en asepsico1@gmail.com.

## 7. Tus derechos

Puedes ejercer tus derechos de acceso, rectificación, supresión, oposición, limitación del
tratamiento y portabilidad escribiendo a asepsico1@gmail.com con el asunto "Privacidad piloto demo".
Te responderemos en el plazo máximo de un mes. Solo te pediremos que acredites tu identidad si
tenemos dudas razonables sobre ella.

Pedir la supresión de tu cuenta supone darte de baja del piloto demo. Los datos que debamos
conservar bloqueados (apartado 4) se mantendrán así hasta el final de su plazo.

Si crees que no hemos tratado bien tus datos, puedes reclamar ante la Agencia Española de Protección
de Datos (www.aepd.es, C/ Jorge Juan 6, 28001 Madrid). Te agradeceremos que antes nos escribas para
intentar resolverlo.

## 8. Decisiones automatizadas, perfiles y cookies

- No tomamos decisiones automatizadas sobre ti ni elaboramos perfiles. El piloto demo no usa
  inteligencia artificial.
- La aplicación solo usa las cookies técnicas necesarias para iniciar sesión y mantenerla segura.
  No necesitan tu consentimiento (art. 22.2 de la Ley 34/2002). No usamos cookies de análisis ni de
  publicidad.

## 9. Seguridad

Aplicamos medidas como la verificación en dos pasos obligatoria para titulares, administradores y
terapeutas, el aislamiento de cada espacio y el registro de actividad. Aun así, el piloto demo es un
**entorno de prueba**: no introduzcas datos reales de pacientes ni datos de salud de nadie.

## 10. Cambios en esta política

Si cambiamos algo importante, te mostraremos la nueva versión al entrar en AsePsico.
`;
