/*
 * Configuración de la landing de AsePsico.
 * Es el único sitio que hay que tocar para cambiar enlaces, datos legales o encender/apagar bloques.
 * Sin dependencias ni peticiones a terceros.
 */
window.ASEPSICO_CONFIG = Object.freeze({
  // Formulario de la lista de espera (Google Forms). Se abre como enlace normal en una
  // pestaña nueva: nunca incrustado. Si cambia, actualiza también los href de index.html
  // (son el respaldo para quien navega sin JavaScript).
  FORM_URL: 'https://forms.gle/ceKKYV85j1rq4EHZ9',

  // Política de privacidad del formulario de la lista de espera (página propia de la web).
  // Los enlaces ya van con este href en el HTML; esta constante solo lo sobrescribe si cambia.
  FORM_PRIVACY_URL: '/privacidad-lista-espera/',

  // Email de contacto del pie y de las páginas legales.
  CONTACT_EMAIL: 'asepsico1@gmail.com',

  // Título del aviso al entrar (decisión del Jefe). Si se deja vacío, el aviso no se muestra.
  POPUP_TITLE: 'Sé de los primeros en probar AsePsico',

  // Texto del desplegable "Precios" (sin uso: FEATURES.pricingDetails está apagado).
  // Solo se muestra si FEATURES.pricingDetails es true y este texto no está vacío.
  PRICING_TEXT: '',

  // El NIF y el domicilio del titular están escritos en HTML estático en aviso-legal/index.html.

  FEATURES: Object.freeze({
    // Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?".
    // APAGADA hasta que el Jefe la apruebe tras la revisión de Argos y Pax.
    calculadora: false,

    // Pregunta frecuente "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112.
    // ENCENDIDA, pendiente de confirmación del Jefe. Verificar el 024 antes de publicar.
    faqPacientes: true,

    // Enlace a Instagram @asepsico en el pie. APAGADO hasta que se corrija la bio.
    instagram: false,

    // Aviso al entrar (título en POPUP_TITLE), a los 8 s o al 50 % del scroll.
    // Solo enlaza al formulario; no recoge datos ni guarda nada en el navegador.
    leadPopup: true,

    // Desplegable "Precios" en la tarjeta del piloto. APAGADO por decisión del Jefe: sin precios en la web.
    pricingDetails: false,
  }),
});
