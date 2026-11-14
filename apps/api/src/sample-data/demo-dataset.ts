/**
 * Datos INVENTADOS del espacio de demostración. Reglas (las comprueba un test de seguridad):
 *  - Nombres obviamente ficticios (apellidos "Demo", "Ejemplo", "Inventada"...), correos @example.test.
 *  - Solo personas adultas (ninguna menor de edad; acceso al portal solo como PATIENT).
 *  - Contenido clínico genérico y leve: sin ideación suicida, autolesiones, violencia, abuso,
 *    sustancias, diagnósticos ni medicación. Nada que pueda parecer un caso real.
 *  - Todo texto narrativo empieza por "[Ejemplo ficticio]", visible en la demo.
 *  - Escalas solo GAD-7 y WHO-5 (el PHQ-9 incluye un ítem de riesgo: no se siembra).
 * Las fechas son relativas al momento de la siembra (días antes/después de "hoy").
 */

export const FICTION_PREFIX = '[Ejemplo ficticio] ';
export const T = (text: string) => `${FICTION_PREFIX}${text}`;

export type DemoClinician = 'OWNER' | 'THERAPIST';

export interface DemoProcessSpec {
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  title: string;
  reason: string;
  goals: string;
  internalNotes: string;
  modality: 'IN_PERSON' | 'ONLINE' | 'HYBRID';
  frequency: string;
  startedDaysAgo: number;
  /** CLOSED: días desde el cierre. PAUSED: días desde la pausa. */
  stoppedDaysAgo?: number;
  pastSessions: number;
  futureSessions: number;
}

export interface DemoTaskSpec {
  title: string;
  instructions: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUBMITTED' | 'COMPLETED';
  dueInDays: number;
  patientFeedback?: string;
  reviewComment?: string;
}

export interface DemoPatientSpec {
  firstName: string;
  lastName: string;
  ageYears: number;
  status: 'ACTIVE' | 'PAUSED' | 'DISCHARGED';
  clinician: DemoClinician;
  consultationReason: string;
  portal?: boolean;
  history?: { currentProblem: string; personalHistory: string; protectiveFactors: string; clinicalObservations: string };
  goals: { title: string; description: string; status: 'ACTIVE' | 'ACHIEVED' }[];
  tasks: DemoTaskSpec[];
  assessments: { scaleCode: 'GAD7' | 'WHO5'; answers: number[]; daysAgo: number }[];
  messages: { from: 'PATIENT' | 'PROFESSIONAL'; body: string; daysAgo: number }[];
  processes: DemoProcessSpec[];
}

/** Notas de sesión genéricas (rotan entre las sesiones pasadas). */
export const SESSION_NOTES = [
  T('Sesión de seguimiento. Se revisa la tarea de la semana y se ajusta el plan para los próximos días.'),
  T('Se trabaja la identificación de situaciones que generan tensión y alternativas para afrontarlas.'),
  T('Se practica una técnica de respiración y se acuerda usarla dos veces al día.'),
  T('Se repasan avances y dificultades. Buena implicación en la sesión.'),
  T('Se trabaja la planificación semanal con bloques de descanso.'),
  T('Sesión centrada en comunicación asertiva con ejemplos inventados de role-play.'),
];
export const SESSION_SUMMARIES = [
  T('Resumen interno de ejemplo: evolución estable; mantener frecuencia.'),
  T('Resumen interno de ejemplo: revisar la tarea pendiente en la próxima sesión.'),
];

const reading = (title: string): DemoTaskSpec => ({ title, instructions: T('Lee el material y apunta dos ideas que te resulten útiles.'), status: 'PENDING', dueInDays: 5 });

export const DEMO_PATIENTS: DemoPatientSpec[] = [
  {
    firstName: 'Paciente', lastName: 'Demo', ageYears: 34, status: 'ACTIVE', clinician: 'OWNER', portal: true,
    consultationReason: T('Estrés laboral y dificultad para desconectar al terminar la jornada.'),
    history: {
      currentProblem: T('Refiere cansancio y preocupación por la carga de trabajo en los últimos meses.'),
      personalHistory: T('Sin antecedentes relevantes. Trabaja en una oficina inventada.'),
      protectiveFactors: T('Buena red de apoyo, practica deporte los fines de semana.'),
      clinicalObservations: T('Colaboradora y con buena adherencia a las tareas.'),
    },
    goals: [
      { title: T('Establecer una rutina de desconexión al final del día'), description: T('Dedicar 20 minutos a una actividad agradable sin pantallas.'), status: 'ACTIVE' },
      { title: T('Reducir la sensación de agobio los lunes'), description: T('Planificar la semana el domingo por la tarde.'), status: 'ACHIEVED' },
    ],
    tasks: [
      { title: T('Registro de momentos de tensión'), instructions: T('Anota cada día una situación de tensión, qué pensaste y qué hiciste.'), status: 'PENDING', dueInDays: 4 },
      { title: T('Práctica de respiración diafragmática'), instructions: T('Practica 5 minutos por la mañana y 5 por la noche.'), status: 'SUBMITTED', dueInDays: -1, patientFeedback: T('Lo he hecho casi todos los días; por la noche me cuesta más.') },
      { title: T('Planificación semanal'), instructions: T('Rellena la plantilla de planificación con descansos.'), status: 'COMPLETED', dueInDays: -9, patientFeedback: T('Hecho, me ha ayudado a ver la semana.'), reviewComment: T('Muy bien. Mantén los descansos que has incluido.') },
    ],
    assessments: [{ scaleCode: 'GAD7', answers: [2, 1, 2, 1, 1, 1, 1], daysAgo: 40 }, { scaleCode: 'GAD7', answers: [1, 1, 1, 0, 1, 0, 1], daysAgo: 6 }],
    messages: [
      { from: 'PROFESSIONAL', body: T('Hola, te he dejado una tarea nueva en el portal. Cualquier duda me dices.'), daysAgo: 6 },
      { from: 'PATIENT', body: T('Gracias, la empiezo esta semana. ¿Puedo hacerla por la noche?'), daysAgo: 5 },
      { from: 'PROFESSIONAL', body: T('Sí, cuando te venga mejor. Lo comentamos en la próxima sesión.'), daysAgo: 5 },
    ],
    processes: [
      { status: 'CLOSED', title: 'Proceso anterior (ejemplo)', reason: T('Organización del tiempo durante un cambio de puesto.'), goals: T('Mejorar la organización semanal.'), internalNotes: T('Nota interna de ejemplo: proceso cerrado por objetivos cumplidos.'), modality: 'IN_PERSON', frequency: 'Quincenal', startedDaysAgo: 400, stoppedDaysAgo: 300, pastSessions: 4, futureSessions: 0 },
      { status: 'ACTIVE', title: 'Gestión del estrés (ejemplo)', reason: T('Estrés laboral y dificultad para desconectar.'), goals: T('Desconectar al final del día y planificar descansos.'), internalNotes: T('Nota interna de ejemplo: valorar espaciar sesiones en un mes.'), modality: 'HYBRID', frequency: 'Semanal', startedDaysAgo: 60, pastSessions: 6, futureSessions: 2 },
    ],
  },
  {
    firstName: 'Lucía', lastName: 'Inventada', ageYears: 29, status: 'ACTIVE', clinician: 'OWNER', portal: true,
    consultationReason: T('Le cuesta dormir antes de los exámenes de una oposición inventada.'),
    history: {
      currentProblem: T('Dificultad para conciliar el sueño en épocas de estudio intenso.'),
      personalHistory: T('Sin antecedentes relevantes.'),
      protectiveFactors: T('Muy constante y con apoyo de su familia (ficticia).'),
      clinicalObservations: T('Buena capacidad de autoobservación.'),
    },
    goals: [{ title: T('Mejorar la rutina de sueño'), description: T('Horario regular de acostarse y levantarse.'), status: 'ACTIVE' }],
    tasks: [
      { title: T('Diario de sueño'), instructions: T('Registra la hora de acostarte, de levantarte y cómo has descansado.'), status: 'IN_PROGRESS', dueInDays: 3 },
      { title: T('Higiene del sueño'), instructions: T('Elige tres pautas de la lista y pruébalas una semana.'), status: 'COMPLETED', dueInDays: -12, patientFeedback: T('He probado a no mirar el móvil en la cama.'), reviewComment: T('Buen trabajo, seguimos con esa pauta.') },
    ],
    assessments: [{ scaleCode: 'WHO5', answers: [3, 2, 2, 3, 3], daysAgo: 20 }],
    messages: [
      { from: 'PATIENT', body: T('Esta semana he dormido algo mejor, gracias.'), daysAgo: 2 },
    ],
    processes: [
      { status: 'ACTIVE', title: 'Rutina de sueño (ejemplo)', reason: T('Sueño irregular en épocas de estudio.'), goals: T('Rutina de sueño estable.'), internalNotes: T('Nota interna de ejemplo: revisar diario de sueño.'), modality: 'ONLINE', frequency: 'Semanal', startedDaysAgo: 35, pastSessions: 4, futureSessions: 2 },
    ],
  },
  {
    firstName: 'Marco', lastName: 'Ejemplo', ageYears: 45, status: 'ACTIVE', clinician: 'OWNER',
    consultationReason: T('Quiere mejorar la comunicación con su equipo de trabajo.'),
    goals: [{ title: T('Practicar la comunicación asertiva'), description: T('Expresar desacuerdos de forma tranquila en reuniones.'), status: 'ACTIVE' }],
    tasks: [reading(T('Lectura sobre comunicación asertiva'))],
    assessments: [],
    messages: [],
    processes: [
      { status: 'ACTIVE', title: 'Habilidades de comunicación (ejemplo)', reason: T('Comunicación con el equipo.'), goals: T('Comunicación asertiva en el trabajo.'), internalNotes: T('Nota interna de ejemplo.'), modality: 'IN_PERSON', frequency: 'Semanal', startedDaysAgo: 21, pastSessions: 3, futureSessions: 2 },
    ],
  },
  {
    firstName: 'Ana', lastName: 'Prueba', ageYears: 52, status: 'ACTIVE', clinician: 'OWNER',
    consultationReason: T('Adaptación a un cambio de ciudad por trabajo.'),
    goals: [
      { title: T('Crear nuevas rutinas en la ciudad'), description: T('Apuntarse a una actividad de grupo.'), status: 'ACTIVE' },
      { title: T('Mantener el contacto con sus amistades'), description: T('Una llamada a la semana.'), status: 'ACHIEVED' },
    ],
    tasks: [{ title: T('Buscar una actividad de grupo'), instructions: T('Busca dos actividades que te apetezcan cerca de casa.'), status: 'SUBMITTED', dueInDays: -2, patientFeedback: T('He encontrado un club de lectura y un grupo de senderismo.') }],
    assessments: [{ scaleCode: 'WHO5', answers: [2, 2, 3, 2, 3], daysAgo: 15 }],
    messages: [],
    processes: [
      { status: 'CLOSED', title: 'Proceso breve anterior (ejemplo)', reason: T('Organización tras un cambio de horario.'), goals: T('Ajustar rutinas.'), internalNotes: T('Nota interna de ejemplo: cierre por alta.'), modality: 'IN_PERSON', frequency: 'Quincenal', startedDaysAgo: 500, stoppedDaysAgo: 430, pastSessions: 3, futureSessions: 0 },
      { status: 'ACTIVE', title: 'Adaptación al cambio (ejemplo)', reason: T('Adaptación a la nueva ciudad.'), goals: T('Rutinas y red social en la nueva ciudad.'), internalNotes: T('Nota interna de ejemplo.'), modality: 'ONLINE', frequency: 'Quincenal', startedDaysAgo: 45, pastSessions: 3, futureSessions: 1 },
    ],
  },
  {
    firstName: 'Tomás', lastName: 'Ficticio', ageYears: 38, status: 'PAUSED', clinician: 'OWNER',
    consultationReason: T('Organización del tiempo entre trabajo y estudios.'),
    goals: [{ title: T('Planificar la semana'), description: T('Usar una agenda semanal.'), status: 'ACTIVE' }],
    tasks: [],
    assessments: [],
    messages: [],
    processes: [
      { status: 'PAUSED', title: 'Organización del tiempo (ejemplo)', reason: T('Equilibrio entre trabajo y estudios.'), goals: T('Agenda semanal realista.'), internalNotes: T('Nota interna de ejemplo: pausa acordada por viaje de trabajo inventado.'), modality: 'ONLINE', frequency: 'Quincenal', startedDaysAgo: 120, stoppedDaysAgo: 20, pastSessions: 5, futureSessions: 0 },
    ],
  },
  {
    firstName: 'Clara', lastName: 'Simulada', ageYears: 61, status: 'DISCHARGED', clinician: 'OWNER',
    consultationReason: T('Quería recuperar actividades de ocio tras la jubilación.'),
    goals: [{ title: T('Recuperar aficiones'), description: T('Retomar la pintura dos tardes a la semana.'), status: 'ACHIEVED' }],
    tasks: [{ title: T('Agenda de actividades agradables'), instructions: T('Apunta las actividades agradables de la semana.'), status: 'COMPLETED', dueInDays: -150, patientFeedback: T('He vuelto a pintar.'), reviewComment: T('Estupendo.') }],
    assessments: [],
    messages: [],
    processes: [
      { status: 'CLOSED', title: 'Activación y ocio (ejemplo)', reason: T('Actividades de ocio tras la jubilación.'), goals: T('Retomar aficiones.'), internalNotes: T('Nota interna de ejemplo: alta por objetivos cumplidos.'), modality: 'IN_PERSON', frequency: 'Quincenal', startedDaysAgo: 240, stoppedDaysAgo: 120, pastSessions: 6, futureSessions: 0 },
    ],
  },
  {
    firstName: 'Julia', lastName: 'Ejemplar', ageYears: 27, status: 'ACTIVE', clinician: 'OWNER',
    consultationReason: T('Nervios al hablar en público en presentaciones de clase de máster.'),
    goals: [{ title: T('Preparar presentaciones con más calma'), description: T('Ensayo graduado de presentaciones.'), status: 'ACTIVE' }],
    tasks: [{ title: T('Ensayo de una presentación corta'), instructions: T('Ensaya 3 minutos delante del espejo y apunta cómo te has sentido.'), status: 'PENDING', dueInDays: 6 }],
    assessments: [{ scaleCode: 'GAD7', answers: [1, 1, 2, 1, 0, 1, 1], daysAgo: 10 }],
    messages: [],
    processes: [
      { status: 'ACTIVE', title: 'Hablar en público (ejemplo)', reason: T('Nervios en presentaciones.'), goals: T('Ensayo graduado.'), internalNotes: T('Nota interna de ejemplo.'), modality: 'IN_PERSON', frequency: 'Semanal', startedDaysAgo: 14, pastSessions: 2, futureSessions: 2 },
    ],
  },
  // Pacientes del Terapeuta Demo: el titular NO ve su contenido clínico (E1: "cada profesional ve lo suyo").
  {
    firstName: 'Diego', lastName: 'Muestra', ageYears: 41, status: 'ACTIVE', clinician: 'THERAPIST',
    consultationReason: T('Irritabilidad en épocas de mucho trabajo.'),
    goals: [{ title: T('Identificar señales de cansancio'), description: T('Registro semanal.'), status: 'ACTIVE' }],
    tasks: [{ title: T('Registro de señales de cansancio'), instructions: T('Anota cuándo notas más cansancio durante la semana.'), status: 'PENDING', dueInDays: 5 }],
    assessments: [],
    messages: [],
    processes: [
      { status: 'ACTIVE', title: 'Regulación emocional (ejemplo)', reason: T('Irritabilidad en épocas de trabajo.'), goals: T('Identificar señales y pausas.'), internalNotes: T('Nota interna de ejemplo del terapeuta.'), modality: 'IN_PERSON', frequency: 'Semanal', startedDaysAgo: 28, pastSessions: 3, futureSessions: 2 },
    ],
  },
  {
    firstName: 'Elena', lastName: 'Inventada', ageYears: 33, status: 'ACTIVE', clinician: 'THERAPIST',
    consultationReason: T('Quiere ganar confianza para cambiar de trabajo.'),
    goals: [{ title: T('Preparar entrevistas de trabajo'), description: T('Ensayo de entrevistas.'), status: 'ACTIVE' }],
    tasks: [],
    assessments: [{ scaleCode: 'WHO5', answers: [3, 3, 2, 3, 2], daysAgo: 8 }],
    messages: [],
    processes: [
      { status: 'ACTIVE', title: 'Autoconfianza (ejemplo)', reason: T('Cambio de trabajo.'), goals: T('Preparar entrevistas.'), internalNotes: T('Nota interna de ejemplo del terapeuta.'), modality: 'ONLINE', frequency: 'Semanal', startedDaysAgo: 18, pastSessions: 2, futureSessions: 1 },
    ],
  },
  {
    firstName: 'Óscar', lastName: 'Ficticio', ageYears: 48, status: 'PAUSED', clinician: 'THERAPIST',
    consultationReason: T('Equilibrio entre vida personal y horarios por turnos.'),
    goals: [],
    tasks: [],
    assessments: [],
    messages: [],
    processes: [
      { status: 'PAUSED', title: 'Horarios y descanso (ejemplo)', reason: T('Horarios por turnos.'), goals: T('Rutina de descanso.'), internalNotes: T('Nota interna de ejemplo del terapeuta.'), modality: 'IN_PERSON', frequency: 'Quincenal', startedDaysAgo: 90, stoppedDaysAgo: 15, pastSessions: 3, futureSessions: 0 },
    ],
  },
];

/** Palabras que nunca deben aparecer en el contenido sembrado (lo comprueba un test). */
export const FORBIDDEN_DEMO_TERMS = [
  'suicid', 'autolesi', 'morir', 'muerte', 'abuso', 'maltrato', 'violencia', 'agresi', 'droga', 'alcohol',
  'medicaci', 'fármaco', 'farmaco', 'diagnóstico', 'trastorno', 'menor de edad', 'hijo', 'hija', 'niño', 'niña', 'adolescente',
];
