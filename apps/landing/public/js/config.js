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

  // TODO(Jefe): URL publicada de la política de privacidad del formulario de la lista de espera.
  // Mientras esté vacía, la web dice que el formulario tiene su propia política pero no la enlaza.
  // Al rellenarla, añade su dominio a ALLOWED_HOSTS en scripts/check-landing.mjs.
  FORM_PRIVACY_URL: '',

  // Email de contacto del pie y de las páginas legales.
  CONTACT_EMAIL: 'asepsico1@gmail.com',

  // Datos del titular para el aviso legal y la política de privacidad (art. 10 LSSI).
  // Único sitio donde van. TODO(Jefe): sustituir los marcadores antes de publicar; sin ellos
  // no se publica la web.
  LEGAL: Object.freeze({
    NIF: '[[NIF]]',
    DOMICILIO: '[[DOMICILIO]]',
  }),

  FEATURES: Object.freeze({
    // Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?".
    // APAGADA hasta que el Jefe la apruebe tras la revisión de Argos y Pax.
    calculadora: false,

    // Pregunta frecuente "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112.
    // ENCENDIDA, pendiente de confirmación del Jefe. Verificar el 024 antes de publicar.
    faqPacientes: true,

    // Enlace a Instagram @asepsico en el pie. APAGADO hasta que se corrija la bio.
    instagram: false,

    // Aviso al entrar "¿Te avisamos cuando abramos el piloto?" (a los 8 s o al 50 % del scroll).
    // Solo enlaza al formulario; no recoge datos ni guarda nada en el navegador.
    leadPopup: true,
  }),
});
