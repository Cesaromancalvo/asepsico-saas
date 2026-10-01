/*
 * Configuración de la landing de AsePsico.
 * Es el único sitio que hay que tocar para cambiar enlaces o encender/apagar bloques.
 * Sin dependencias ni peticiones a terceros.
 */
window.ASEPSICO_CONFIG = Object.freeze({
  // Formulario de la lista de espera (Google Forms). Se abre como enlace normal en una
  // pestaña nueva: nunca incrustado. Si cambia, actualiza también los href de index.html
  // (son el respaldo para quien navega sin JavaScript).
  FORM_URL: 'https://forms.gle/ceKKYV85j1rq4EHZ9',

  // TODO(Jefe): email de contacto del pie y del aviso legal. Mientras esté vacío,
  // el enlace "Contacto" no se muestra.
  CONTACT_EMAIL: '',

  FEATURES: Object.freeze({
    // Calculadora "¿Cuánto tiempo te lleva lo que no sale en la agenda?".
    // APAGADA hasta que el Jefe la apruebe tras la revisión de Argos y Pax.
    calculadora: false,

    // Pregunta frecuente "Soy paciente, ¿puedo apuntarme?" con el 024 y el 112.
    // ENCENDIDA, pendiente de confirmación del Jefe. Verificar el 024 antes de publicar.
    faqPacientes: true,
  }),
});
