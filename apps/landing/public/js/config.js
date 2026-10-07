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

  // Cuenta "Lo que te cuesta hoy" (FEATURES.savingsCalculator). Decisión del Jefe (07/10): la web
  // NO dice cuánto ahorra AsePsico. Solo suma las horas que la persona escribe, las pasa al mes y,
  // si escribe el valor de su hora, a euros. Sin supuestos de ahorro, sin precios ni coste de la
  // herramienta (restarlo daría a entender que AsePsico elimina todo ese tiempo).
  SAVINGS: Object.freeze({
    // Mes medio: 46 semanas de trabajo al año (6 de vacaciones y festivos) entre 12 meses = 3,83.
    WEEKS_PER_YEAR: 46,
    // Límites: horas a la semana por tarea y valor de la hora en euros. Los campos empiezan vacíos:
    // el resultado inicial es 0 (Lex Psi, cambio 3, sin cifras de ejemplo como valor).
    MAX_HOURS: 40,
    MAX_VALUE: 500,
    // Tareas, en este orden (lista de Vega, calculadora-tareas-v3, 07/10; versión por defecto, el Jefe
    // aún puede ajustarla). Textos revisados por Clio (07/10). Para cambiar una tarea basta con editar esta lista:
    // id (único, sin espacios), label (etiqueta), help (una línea bajo la etiqueta) y placeholder
    // (ejemplo en gris dentro del campo: NO cuenta en el cálculo; [SUPUESTO] del equipo).
    // Los campos, el gráfico y la leyenda se generan solos.
    TASKS: Object.freeze([
      Object.freeze({ id: 'agenda', label: 'Agenda, citas y recordatorios', placeholder: '1,5',
        help: 'Dar y cambiar citas, gestionar cancelaciones y huecos, recordar citas por WhatsApp o por teléfono.' }),
      Object.freeze({ id: 'altas', label: 'Altas, consentimientos y papeleo legal', placeholder: '0,5',
        help: 'Recoger los datos de pacientes nuevos, consentimientos, protección de datos, archivo y peticiones de copia.' }),
      Object.freeze({ id: 'preparar', label: 'Preparar las sesiones', placeholder: '2',
        help: 'Antes de la sesión: releer notas, decidir qué trabajar, buscar técnicas. Las notas van en la tarea siguiente.' }),
      Object.freeze({ id: 'notas', label: 'Notas de sesión e historia clínica', placeholder: '3',
        help: 'Después de la sesión: escribir o pasar a limpio las notas, actualizar la historia clínica, pasar del papel al ordenador.' }),
      Object.freeze({ id: 'material', label: 'Crear material para pacientes', placeholder: '1,5',
        help: 'Hacer o adaptar fichas, autorregistros, tareas o psicoeducación. Enviarlos va en el seguimiento.' }),
      Object.freeze({ id: 'seguimiento', label: 'Seguimiento entre sesiones', placeholder: '1,5',
        help: 'Enviar y recoger tareas y cuestionarios, corregir escalas, contestar mensajes por WhatsApp o email.' }),
      Object.freeze({ id: 'informes', label: 'Informes', placeholder: '1',
        help: 'Informes para el paciente, el centro escolar, el médico, el juzgado o la mutua; buscar los datos para hacerlos.' }),
      Object.freeze({ id: 'coordinacion', label: 'Coordinación con otros profesionales', placeholder: '0,5',
        help: 'Hablar con psiquiatría, el médico o el centro escolar, derivaciones; si trabajas en un centro, también reuniones de casos.' }),
      Object.freeze({ id: 'facturas', label: 'Facturas, cobros y gestoría', placeholder: '1,5',
        help: 'Hacer facturas, reclamar pagos, cuadrar ingresos, papeles para la gestoría, volantes de mutuas.' }),
    ]),
    // Filas opcionales "Otra tarea" (nombre de la actividad + horas), hasta este número, con el botón
    // "+ Añadir otra tarea". 0 las quita. Suman en el cálculo y no salen del navegador.
    OTHER_TASKS: 3,
    OTHER_NAME_MAX: 40,
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

    // Cuenta "Lo que te cuesta hoy": horas a la semana y al mes de tareas administrativas, su valor en
    // euros si se escribe el valor de la hora y el reparto en %. Sin ahorro ni precios. Todo en el navegador.
    // APAGADA: la enciende el Jefe cuando la vea (y tras Lex Psi y Clio). main se despliega en asepsico.es.
    savingsCalculator: false,

    // Aviso de la lista de espera (título en POPUP_TITLE). Sale solo al pasar el 50 % del scroll (sin
    // temporizador, para no tapar el contenido al entrar: criterio de intersticial intrusivo de Google);
    // en móvil es una barra pequeña abajo. Solo enlaza al formulario; no recoge ni guarda nada.
    leadPopup: true,

    // Desplegable "Precios" en la tarjeta del piloto. APAGADO por decisión del Jefe: sin precios en la web.
    pricingDetails: false,
  }),
});
