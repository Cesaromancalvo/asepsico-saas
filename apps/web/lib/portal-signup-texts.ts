/*
 * Textos legales del alta en el portal con el QR fijo del profesional: capa 1 (pantalla de la
 * solicitud), capa 2 (información completa) y normas de uso. Versión 1.0-BORRADOR de Lex Psi
 * (20/10/2026), PENDIENTE DE REVISIÓN POR UN ABOGADO: no usar con pacientes reales.
 *
 * Las versiones deben coincidir con PORTAL_SIGNUP_NOTICE_VERSIONS de la API (lo comprueba
 * test/portal-signup.spec.tsx). Cambiar un texto obliga a subir su versión en los dos sitios.
 *
 * Variables: hoy no hay ningún endpoint público que devuelva los datos del responsable (la
 * consulta) antes de enviar el formulario (hallazgo H1 de Lex). Mientras no exista, se muestran
 * como marcador visible. NUNCA se nombra al profesional del QR: el responsable es la consulta.
 */

export const NOTICE_VERSION_LABEL = 'v1.0-borrador · 20/10/2026';

/** Marcador visible para los datos del responsable que aún no sirve la API. */
export const PENDING_PRACTICE_DATA = '[Datos de la consulta pendientes]';

/** Datos de la consulta que rellenará el endpoint público de aviso (H1). null = pendiente. */
export type NoticeVariables = {
  nombreConsulta: string | null;
  titularResponsable: string | null;
  nifResponsable: string | null;
  domicilioResponsable: string | null;
  emailPrivacidad: string | null;
  contactoDpd: string | null;
};

export const PENDING_VARIABLES: NoticeVariables = {
  nombreConsulta: null, titularResponsable: null, nifResponsable: null, domicilioResponsable: null, emailPrivacidad: null, contactoDpd: null,
};

/** Fragmento de texto: literal o variable (para pintar la variable pendiente como marcador). */
export type TextPart = string | { variable: keyof NoticeVariables };
export type RichText = TextPart[];

export const v = (variable: keyof NoticeVariables): TextPart => ({ variable });

/** Capa 1: encima del formulario y junto a las casillas (§1.2). */
export const LAYER1 = {
  title: ['Solicitud de acceso al portal de pacientes de ', v('nombreConsulta')] as RichText,
  intro: [
    'Con este formulario pides a ', v('nombreConsulta'), ' que te dé acceso a su portal de pacientes. ',
  ] as RichText,
  introStrong: 'Todavía no se crea ninguna cuenta.',
  introEnd: ' La consulta revisará tu solicitud y, si la acepta, te dará en persona un enlace para que elijas tu contraseña. El enlace caduca a las 72 horas.',
  heading: 'Información básica sobre protección de datos',
  items: [
    { term: 'Responsable', text: [v('titularResponsable'), ' (', v('nombreConsulta'), '). Contacto: ', v('emailPrivacidad'), '.'] as RichText },
    { term: 'Para qué', text: ['revisar tu solicitud, comprobar tu identidad y, si se acepta, crear tu cuenta del portal y relacionarla con tu ficha en la consulta.'] as RichText },
    { term: 'Base jurídica', text: ['tu propia solicitud y la relación de atención con la consulta. No es un consentimiento.'] as RichText },
    { term: 'Quién más trata tus datos', text: ['AsePsico, la empresa que presta el portal a la consulta, lo hace por encargo de la consulta y solo siguiendo sus instrucciones. Tus datos no se ceden a terceros salvo por obligación legal.'] as RichText },
    { term: 'Cuánto tiempo', text: ['si la consulta no resuelve tu solicitud en 14 días, se borra. Si la rechaza, se borra. Si la acepta, los datos pasan a tu ficha y se conservan como los demás datos de tu atención.'] as RichText },
    { term: 'Tus derechos', text: ['puedes acceder a tus datos, rectificarlos, suprimirlos, limitar su uso, oponerte o pedir su portabilidad escribiendo a ', v('emailPrivacidad'), '. También puedes reclamar ante la Agencia Española de Protección de Datos.'] as RichText },
  ],
  fullInfoLink: 'Información completa sobre protección de datos',
};

/** Aviso de urgencias (buena práctica, coherente con el resto del portal). */
export const EMERGENCY_TITLE = 'El portal no es un canal de urgencias.';
export const EMERGENCY_TEXT = 'Si es una urgencia, llama al 112. Si tienes pensamientos de suicidio, llama al 024.';

/** Casillas (§2): desmarcadas, separadas, sin «consiento». */
export const PRIVACY_ACK_LABEL = 'He leído la información sobre protección de datos.';
export const PORTAL_TERMS_LABEL_BEFORE = 'Acepto las ';
export const PORTAL_TERMS_LINK = 'normas de uso del portal';
export const PORTAL_TERMS_LABEL = `${PORTAL_TERMS_LABEL_BEFORE}${PORTAL_TERMS_LINK}.`;

/** Capa 2: información completa (§1.3). Sin las notas internas de Lex ni los marcadores de trabajo. */
export const LAYER2: { title: string; rows: { term: string; text: RichText }[] } = {
  title: 'Información sobre protección de datos: solicitud y cuenta del portal de pacientes',
  rows: [
    { term: 'Responsable del tratamiento', text: [v('titularResponsable'), ', con NIF ', v('nifResponsable'), ' y domicilio en ', v('domicilioResponsable'), ', que gestiona la consulta ', v('nombreConsulta'), '. Contacto para protección de datos: ', v('emailPrivacidad'), '.'] },
    { term: 'Quién atiende tu solicitud', text: ['La solicitud llega al profesional cuyo código QR has escaneado y la puede revisar el personal autorizado de ', v('nombreConsulta'), ': quien la gestione y, si ese profesional ya no está disponible, la dirección o administración de la consulta. El responsable es siempre la consulta, no un profesional concreto.'] },
    { term: 'Encargado del tratamiento', text: ['AsePsico [datos pendientes] presta el portal a la consulta y trata los datos por su cuenta, según sus instrucciones y con un contrato de encargo del tratamiento (art. 28 RGPD). AsePsico no usa tus datos para fines propios.'] },
    { term: 'Qué datos tratamos', text: ['Con la solicitud: nombre, apellidos, correo electrónico, fecha de nacimiento y, si lo das, teléfono. También la constancia de que leíste esta información y aceptaste las normas de uso, con su versión y fecha. Si se acepta y activas la cuenta: tu contraseña (no la guardamos tal cual, solo una huella que no se puede revertir) y datos técnicos de acceso para proteger tu cuenta (fecha y hora de los accesos e intentos fallidos). Por seguridad: para limitar abusos, el sistema usa durante un tiempo breve la dirección IP desde la que se envía el formulario.'] },
    { term: 'Por qué es un dato sensible', text: ['Pedir acceso al portal de una consulta de psicología permite deducir que eres o quieres ser paciente. Por eso lo tratamos como un dato relativo a la salud y lo protegemos como tal.'] },
    { term: 'Para qué', text: ['1) Recibir y revisar tu solicitud. 2) Comprobar en persona que eres tú y relacionar la solicitud con tu ficha o crear una nueva. 3) Darte un enlace de activación y crear tu cuenta. 4) Proteger la cuenta y llevar un registro de seguridad de estas acciones.'] },
    { term: 'Base jurídica', text: ['Tu solicitud y la relación de atención con la consulta: art. 6.1.b RGPD (medidas a petición tuya y prestación del servicio). Para los datos relativos a la salud: art. 9.2.h RGPD (asistencia sanitaria o social), por profesionales sujetos a secreto profesional (art. 9.3 RGPD). Los registros de seguridad se basan además en la obligación de proteger los datos (art. 6.1.c y art. 32 RGPD). No pedimos tu consentimiento para esto y las casillas del formulario no lo son: una confirma que has leído esta información y la otra que aceptas las normas de uso.'] },
    { term: '¿Es obligatorio?', text: ['Nombre, apellidos, correo y fecha de nacimiento, sí: sin ellos no podemos comprobar quién eres ni crear la cuenta. El teléfono es opcional. El portal es voluntario: si no lo usas, tu atención en la consulta no cambia.'] },
    { term: 'Edad', text: ['El alta por este código es para mayores de 18 años. Si tienes menos, la consulta te dará de alta en persona.'] },
    { term: 'Destinatarios', text: ['Ninguna cesión a terceros salvo obligación legal. Tratan los datos, por cuenta de la consulta, AsePsico y los proveedores que alojan el servicio, como subencargados, en las condiciones del contrato de encargo. Lista y ubicación: [pendiente de publicar].'] },
    { term: 'Transferencias fuera del Espacio Económico Europeo', text: ['[Pendiente de confirmar].'] },
    { term: 'Cuánto tiempo', text: ['Solicitud no resuelta: se borra a los 14 días de enviarla. Solicitud rechazada: se borra al rechazarla. Solicitud aceptada: los datos pasan a tu ficha y la consulta los conserva el tiempo que exige la normativa sobre documentación clínica. Enlace de activación no usado: deja de valer a las 72 horas. Cuenta del portal: mientras esté activa; después, bloqueada el tiempo necesario para atender posibles responsabilidades. Registros de seguridad: [plazo pendiente].'] },
    { term: 'Tus derechos', text: ['Acceso, rectificación, supresión, limitación, oposición y portabilidad (arts. 15 a 22 RGPD). Escribe a ', v('emailPrivacidad'), ' con una copia de tu documento de identidad o con otro medio que permita identificarte. La consulta te responderá en el plazo de un mes. Si una solicitud aún pendiente contiene un error, puedes pedir que se corrija o se borre.'] },
    { term: 'Reclamación', text: ['Puedes presentar una reclamación ante la Agencia Española de Protección de Datos (www.aepd.es).'] },
    { term: 'Decisiones automatizadas', text: ['No hay. Una persona de la consulta revisa cada solicitud.'] },
  ],
};

/** Normas de uso del portal (§2.1, versión portal-normas-uso-v1.0-borrador). */
export const PORTAL_TERMS: { title: RichText; items: { term: string; text: RichText }[] } = {
  title: ['Normas de uso del portal de pacientes de ', v('nombreConsulta')],
  items: [
    { term: 'Qué es.', text: ['El portal es un servicio voluntario de ', v('nombreConsulta'), ' para ver tus citas, tareas y mensajes con la consulta. AsePsico lo presta técnicamente por encargo de la consulta. No usar el portal no cambia tu atención.'] },
    { term: 'No es un canal de urgencias.', text: ['Los mensajes no se leen en tiempo real. Si es una urgencia, llama al 112. Si tienes pensamientos de suicidio, llama al 024.'] },
    { term: 'Tu cuenta es personal.', text: ['No compartas tu contraseña ni dejes la sesión abierta en un dispositivo que usen otras personas. Si crees que alguien ha entrado en tu cuenta o has perdido el móvil, avisa cuanto antes a la consulta.'] },
    { term: 'Usa el portal solo para tu propia atención.', text: ['No envíes datos de otras personas sin su permiso ni contenidos ofensivos o ilícitos.'] },
    { term: 'Enlace de activación.', text: ['Te lo da la consulta en persona y es solo para ti. Si alguien te lo pide, no se lo des. Nunca te pediremos la contraseña por teléfono, correo ni mensaje.'] },
    { term: 'Suspensión.', text: ['La consulta puede desactivar tu acceso si se incumplen estas normas, si termina tu atención o por seguridad. Eso no borra tu historia, que se conserva según la ley, y no afecta a tus derechos sobre tus datos.'] },
    { term: 'Cambios.', text: ['Si estas normas cambian, te las mostraremos y te pediremos que las aceptes de nuevo antes de seguir usando el portal.'] },
    { term: 'Dudas.', text: ['Escribe a tu consulta: ', v('emailPrivacidad'), '.'] },
  ],
};

/** Aviso de borrador en las tres pantallas. */
export const DRAFT_NOTICE = 'Textos en borrador, pendientes de revisión legal. Esta página es de prueba: no la uses con pacientes reales.';

/** Frases que Lex prohíbe en esta pantalla (§2 y §4.4). Lo usa el test. */
export const FORBIDDEN_PHRASES = [
  /consiento/i, /doy mi consentimiento/i, /autorizo el tratamiento/i, /acepto la política de privacidad/i,
  /cumplimos el rgpd/i, /100 ?% rgpd/i, /conforme al rgpd/i, /totalmente seguro/i, /seguridad garantizada/i, /todo cifrado/i,
  /extremo a extremo/i, /contraseña se guarda cifrada/i, /crea tu cuenta/i, /plataforma sanitaria/i, /software sanitario/i,
];

/** Texto plano (para tests y para el título de la página). */
export function plain(text: RichText, vars: NoticeVariables = PENDING_VARIABLES): string {
  return text.map((part) => (typeof part === 'string' ? part : vars[part.variable] ?? PENDING_PRACTICE_DATA)).join('');
}
