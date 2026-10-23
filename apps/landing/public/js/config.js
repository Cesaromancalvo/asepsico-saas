/*
 * Configuración de la landing de AsePsico.
 * Es el único sitio que hay que tocar para cambiar enlaces, datos legales o encender/apagar bloques.
 * Sin dependencias ni peticiones a terceros (la única petición de red es a la API propia de la
 * lista de espera, WAITLIST_API_URL: una petición técnica al cargar la portada para despertarla y
 * pedir el token del formulario, y el envío del formulario).
 */
window.ASEPSICO_CONFIG = Object.freeze({
  // API de la lista de espera propia (FEATURES.ownWaitlistForm). Contrato: docs/WAITLIST_API.md.
  // Es el ÚNICO sitio con esta URL: si cambia el host, cambiar también connect-src en la CSP
  // (apps/landing/README.md) y CONNECT_ORIGINS en scripts/check-landing.mjs.
  WAITLIST_API_URL: 'https://asepsico-api.onrender.com/api/v1',

  // Versión de la política que acepta quien se apunta (se envía en privacyPolicyVersion). Tiene que
  // coincidir con la que muestra /privacidad-lista-espera/ y estar entre las que acepta la API
  // (desplegar la API antes que la landing al cambiarla). v4 desde el 22/10/2026; la v3 queda archivada
  // en /privacidad-lista-espera/v3/.
  WAITLIST_POLICY_VERSION: 'lista-espera-v4',

  // RED DE SEGURIDAD: formulario de Google Forms, solo si FEATURES.ownWaitlistForm está apagado.
  // Se abre como enlace normal en una pestaña nueva: nunca incrustado.
  FORM_URL: 'https://forms.gle/ceKKYV85j1rq4EHZ9',

  // Política de privacidad del formulario propio (página de la web, versión lista-espera-v3; la v2 está en /privacidad-lista-espera/v2/).
  // Los enlaces ya van con este href en el HTML; esta constante solo lo sobrescribe si cambia.
  FORM_PRIVACY_URL: '/privacidad-lista-espera/',

  // Política de la versión con Google Forms (lista-espera-v1). Solo se enlaza si se apaga
  // FEATURES.ownWaitlistForm. En ese caso, el enlace de privacidad DENTRO del Google Form también
  // tiene que apuntar aquí (se cambia a mano en Google Forms).
  FORM_PRIVACY_URL_FALLBACK: '/privacidad-lista-espera/v1/',

  // Email de contacto del pie y de las páginas legales.
  CONTACT_EMAIL: 'asepsico1@gmail.com',

  // Título del aviso al entrar. Si se deja vacío, el aviso no se muestra.
  POPUP_TITLE: 'Sé de los primeros en probar AsePsico',

  // Texto del desplegable "Precios" (sin uso: FEATURES.pricingDetails está apagado).
  // Solo se muestra si FEATURES.pricingDetails es true y este texto no está vacío.
  PRICING_TEXT: '',

  // Cuenta "Lo que te cuesta hoy" (FEATURES.savingsCalculator). La web NO dice cuánto ahorra
  // AsePsico. Solo suma las horas que la persona escribe, las pasa al mes y,
  // si escribe el valor de su hora, a euros. Sin supuestos de ahorro, sin precios ni coste de la
  // herramienta (restarlo daría a entender que AsePsico elimina todo ese tiempo).
  SAVINGS: Object.freeze({
    // Mes medio: 46 semanas de trabajo al año (6 de vacaciones y festivos) entre 12 meses = 3,83.
    WEEKS_PER_YEAR: 46,
    // Límites: horas a la semana por tarea y valor de la hora en euros. Los campos empiezan vacíos:
    // el resultado inicial es 0 (sin cifras de ejemplo como valor).
    MAX_HOURS: 40,
    MAX_VALUE: 500,
    // Tareas, en este orden. Para cambiar una tarea basta con editar esta lista:
    // id (único, sin espacios), label (etiqueta), help (una línea bajo la etiqueta) y placeholder
    // (ejemplo en gris dentro del campo: NO cuenta en el cálculo).
    // Los campos, el gráfico y la leyenda se generan solos.
    TASKS: Object.freeze([
      Object.freeze({ id: 'agenda', label: 'Agenda, citas y recordatorios', placeholder: '1,5',
        help: 'Dar y cambiar citas, gestionar cancelaciones y huecos, recordar citas por WhatsApp o por teléfono.' }),
      Object.freeze({ id: 'sesiones', label: 'Preparar sesiones, notas e informes', placeholder: '6',
        help: 'Antes y después de la sesión: releer y escribir notas, actualizar la historia clínica y hacer informes.' }),
      Object.freeze({ id: 'material', label: 'Material y seguimiento entre sesiones', placeholder: '3',
        help: 'Hacer o adaptar fichas y tareas, enviarlas y recogerlas, corregir escalas y contestar mensajes.' }),
      Object.freeze({ id: 'papeleo', label: 'Papeleo, facturas y gestoría', placeholder: '2',
        help: 'Altas, consentimientos y protección de datos; facturas, cobros, gestoría y volantes de mutuas.' }),
    ]),
    }),

  // El NIF y el domicilio del titular NO están en el código: aviso-legal/ y privacidad/ llevan
  // marcadores NIF y DOMICILIO entre dobles corchetes, que rellena apps/landing/build.mjs al publicar.

  FEATURES: Object.freeze({
    // Formulario propio de la lista de espera (sección #apuntate), enviado con fetch a WAITLIST_API_URL.
    // ENCENDIDO. Si se apaga, la sección desaparece y todos los botones vuelven al Google Form
    // (FORM_URL) con la política v1 (FORM_PRIVACY_URL_FALLBACK).
    ownWaitlistForm: true,

    // Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?".
    // APAGADA.
    calculadora: false,

    // Pregunta frecuente "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112.
    // ENCENDIDA.
    faqPacientes: true,

    // Enlace a Instagram @asepsico en el pie. APAGADO hasta que se corrija la bio.
    instagram: false,

    // Cuenta "Lo que te cuesta hoy": horas a la semana y al mes de tareas administrativas, su valor en
    // euros si se escribe el valor de la hora y el reparto en %. Sin ahorro ni precios. Todo en el navegador.
    // ENCENDIDA.
    savingsCalculator: true,

    // Aviso de la lista de espera (título en POPUP_TITLE). Sale solo al pasar el 50 % del scroll (sin
    // temporizador, para no tapar el contenido al entrar: criterio de intersticial intrusivo de Google);
    // en móvil es una barra pequeña abajo. Solo lleva al formulario; no recoge ni guarda nada.
    leadPopup: true,

    // Desplegable "Precios" en la tarjeta del piloto. APAGADO: sin precios en la web.
    pricingDetails: false,
  }),
});
