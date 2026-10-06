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

  // Estimación de tiempo (FEATURES.savingsCalculator). Modelo de Vega (01/10).
  // [REVISAR] Todas las cifras de este bloque son SUPUESTOS del equipo, sin medir: las tienen que
  // validar Pax (metodología) y Lex Psi (publicidad: LCD arts. 5 y 7) antes de publicar.
  // Si cambian low/high, actualiza también la tabla "Cómo calculamos esto" de index.html.
  SAVINGS: Object.freeze({
    WEEKS_PER_MONTH: 4.33,
    // [REVISAR] Escenario prudente: parte de la preparación que deja de hacerse, minutos ahorrados
    // por tarea, parte de pacientes que usa el portal y minutos por recordatorio.
    low: Object.freeze({ prep: 0.15, perTask: 3, portal: 0.5, rem: 0.3 }),
    // [REVISAR] Escenario optimista.
    high: Object.freeze({ prep: 0.35, perTask: 7, portal: 0.8, rem: 0.6 }),
    // Límites de cada campo (también en los atributos min/max del HTML).
    max: Object.freeze({ s: 80, a: 120, t: 200, r: 600, v: 500 }),
    // [REVISAR] Valores de EJEMPLO con los que se rellenan los campos al cargar (v4, petición del
    // Jefe: la tarjeta no debe salir vacía). v = valor de la hora en euros. No son datos de nadie.
    defaults: Object.freeze({ s: 20, a: 10, t: 10, r: 0, v: 50 }),
  }),

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

    // Estimación de tiempo ("¿Cuánto tiempo podrías recuperar cada mes?"): rango de horas al mes y al
    // año con el modelo de Vega y su valor en euros con el valor de la hora (ejemplo en SAVINGS.defaults),
    // sin ROI ni precios. Todo en el navegador.
    // ENCENDIDA en la rama feat/landing-v2 por decisión del Jefe (05/10).
    // OJO: APAGAR (false) antes de fusionar en main si Argos y Pax no la han aprobado: main se
    // despliega solo en asepsico.es.
    savingsCalculator: true,

    // Campo de recordatorios de cita de la estimación. APAGADO: los emails de recordatorio aún no
    // existen; mientras esté apagado, ese bloque cuenta 0.
    savingsReminders: false,

    // Aviso al entrar (título en POPUP_TITLE), a los 8 s o al 50 % del scroll.
    // Solo enlaza al formulario; no recoge datos ni guarda nada en el navegador.
    leadPopup: true,

    // Desplegable "Precios" en la tarjeta del piloto. APAGADO por decisión del Jefe: sin precios en la web.
    pricingDetails: false,
  }),
});
