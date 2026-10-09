/**
 * Escritura de UN paciente inventado con todo lo que cuelga de él, igual que lo escribe la API:
 * campos narrativos cifrados (encryptField / helpers de clinical-crypto), escalas puntuadas con el
 * mismo catálogo que PatientAssessmentsService y todas las filas acotadas al workspace.
 */
import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { encryptField } from '../../../src/common/crypto/field-encryption';
import { encryptAssessmentResult, encryptJsonField } from '../../../src/common/crypto/clinical-crypto';
import { CLINICAL_SCALES } from '../../../src/patients/clinical-scales';
import { DemoPatientSpec, DemoProcessSpec, SESSION_NOTES, SESSION_SUMMARIES } from './demo-dataset';

const DAY = 24 * 60 * 60 * 1000;
const SESSION_MINUTES = 50;

export interface DemoCounts {
  patients: number;
  processes: { ACTIVE: number; PAUSED: number; CLOSED: number };
  sessions: { past: number; future: number };
  sessionNotes: number;
  goals: number;
  tasks: number;
  assessments: number;
  conversations: number;
  messages: number;
  portalAccounts: number;
}

export function emptyCounts(): DemoCounts {
  return { patients: 0, processes: { ACTIVE: 0, PAUSED: 0, CLOSED: 0 }, sessions: { past: 0, future: 0 }, sessionNotes: 0, goals: 0, tasks: 0, assessments: 0, conversations: 0, messages: 0, portalAccounts: 0 };
}

export interface DemoWriteContext {
  workspaceId: string;
  now: Date;
  clinicianIds: { OWNER: string; THERAPIST: string };
}

export interface PortalCredential { patient: string; email: string; password: string }

/** Contraseña aleatoria de 24 caracteres (144 bits). Solo se muestra una vez por la terminal. */
export function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

/** Sufijo aleatorio para correos únicos en toda la plataforma (User.email y portal son únicos). */
export function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function demoPatientEmail(spec: Pick<DemoPatientSpec, 'firstName' | 'lastName'>, suffix: string): string {
  return `${slug(spec.firstName)}.${slug(spec.lastName)}.${suffix}@example.test`;
}

/** Lunes a viernes: un sábado/domingo se mueve al viernes anterior (pasado) o al lunes siguiente (futuro). */
function weekday(date: Date, direction: -1 | 1): Date {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + direction);
  return d;
}

function at(base: Date, daysOffset: number, hour: number, direction: -1 | 1): Date {
  const d = weekday(new Date(base.getTime() + daysOffset * DAY), direction);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function addBusinessDays(base: Date, days: number): Date {
  const d = new Date(base);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

const stepDays =(process: DemoProcessSpec) => (process.frequency === 'Semanal' ? 7 : 14);

export async function writeDemoPatient(tx: Prisma.TransactionClient, ctx: DemoWriteContext, spec: DemoPatientSpec, index: number, counts: DemoCounts): Promise<PortalCredential | null> {
  const { workspaceId, now } = ctx;
  const clinicianId = ctx.clinicianIds[spec.clinician];
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const hour = 9 + (index % 10); // una hora distinta por paciente (9:00–18:00): sin solapes en la agenda

  const birthDate = new Date(Date.UTC(now.getUTCFullYear() - spec.ageYears, (index * 5) % 12, 10));
  const email = demoPatientEmail(spec, randomSuffix());
  const patient = await tx.patient.create({
    data: {
      workspaceId, isDemo: true, firstName: spec.firstName, lastName: spec.lastName, email, birthDate,
      status: spec.status, consultationReason: encryptField(spec.consultationReason),
      createdAt: ago(Math.max(...spec.processes.map((p) => p.startedDaysAgo)) + 2),
    },
    select: { id: true },
  });
  counts.patients++;

  if (spec.history) {
    await tx.clinicalHistory.create({
      data: {
        patientId: patient.id,
        reasonForConsultation: encryptField(spec.consultationReason),
        currentProblem: encryptField(spec.history.currentProblem),
        personalHistory: encryptField(spec.history.personalHistory),
        protectiveFactors: encryptField(spec.history.protectiveFactors),
        clinicalObservations: encryptField(spec.history.clinicalObservations),
      },
    });
  }

  let lastPastSessionId: string | null = null;
  let noteIndex = index;
  for (const process of spec.processes) {
    const startedAt = ago(process.startedDaysAgo);
    const stoppedAt = process.stoppedDaysAgo !== undefined ? ago(process.stoppedDaysAgo) : null;
    const created = await tx.clinicalProcess.create({
      data: {
        workspaceId, patientId: patient.id, therapistId: clinicianId, title: process.title,
        consultationReason: encryptField(process.reason), goals: encryptField(process.goals), internalNotes: encryptField(process.internalNotes),
        modality: process.modality, frequency: process.frequency, status: process.status,
        // createdAt = inicio: la ventana de mensajes del clínico se calcula desde createdAt (E1).
        startedAt, createdAt: startedAt,
        endedAt: process.status === 'CLOSED' ? stoppedAt : null,
        pausedAt: process.status === 'PAUSED' ? stoppedAt : null,
      },
      select: { id: true },
    });
    counts.processes[process.status]++;

    const location = process.modality === 'ONLINE' ? 'Online (ejemplo)' : 'Consulta (ejemplo)';
    const lastPastDaysAgo = process.stoppedDaysAgo ?? 1 + (index % 4);
    for (let k = process.pastSessions - 1; k >= 0; k--) {
      const daysAgo = Math.min(lastPastDaysAgo + k * stepDays(process), process.startedDaysAgo);
      const startsAt = at(now, -daysAgo, hour, -1);
      const note = SESSION_NOTES[noteIndex++ % SESSION_NOTES.length];
      const session = await tx.session.create({
        data: {
          workspaceId, patientId: patient.id, therapistId: clinicianId, clinicalProcessId: created.id,
          startsAt, endsAt: new Date(startsAt.getTime() + SESSION_MINUTES * 60_000), status: 'COMPLETED', type: 'INDIVIDUAL', location,
          notes: encryptField(note), internalSummary: encryptField(k === 0 ? SESSION_SUMMARIES[index % SESSION_SUMMARIES.length] : null),
        },
        select: { id: true },
      });
      counts.sessions.past++;
      counts.sessionNotes++;
      if (process.status === 'ACTIVE') lastPastSessionId = session.id;
    }
    for (let k = 0; k < process.futureSessions; k++) {
      // Primera cita en uno de los 5 próximos días laborables; las siguientes, mismo día de la semana.
      const startsAt = new Date(addBusinessDays(now, 1 + (index % 5)).getTime() + k * stepDays(process) * DAY);
      startsAt.setHours(hour, 0, 0, 0);
      await tx.session.create({
        data: {
          workspaceId, patientId: patient.id, therapistId: clinicianId, clinicalProcessId: created.id,
          startsAt, endsAt: new Date(startsAt.getTime() + SESSION_MINUTES * 60_000), status: 'SCHEDULED', type: 'INDIVIDUAL', location,
        },
      });
      counts.sessions.future++;
    }
  }

  let firstGoalId: string | null = null;
  for (const goal of spec.goals) {
    const row = await tx.therapyGoal.create({
      data: {
        patientId: patient.id, title: encryptField(goal.title)!, description: encryptField(goal.description), status: goal.status,
        achievedAt: goal.status === 'ACHIEVED' ? ago(10) : null, targetDate: goal.status === 'ACTIVE' ? new Date(now.getTime() + 60 * DAY) : null,
      },
      select: { id: true },
    });
    firstGoalId ??= row.id;
    counts.goals++;
  }

  for (const task of spec.tasks) {
    const dueDate = new Date(now.getTime() + task.dueInDays * DAY);
    const assignedAt = new Date(dueDate.getTime() - 7 * DAY);
    const started = task.status !== 'PENDING';
    const submitted = task.status === 'SUBMITTED' || task.status === 'COMPLETED';
    const done = task.status === 'COMPLETED';
    await tx.therapeuticTask.create({
      data: {
        patientId: patient.id, therapyGoalId: firstGoalId, sessionId: lastPastSessionId,
        title: encryptField(task.title)!, instructions: encryptField(task.instructions), status: task.status, dueDate, assignedAt,
        startedAt: started ? new Date(assignedAt.getTime() + DAY) : null,
        submittedAt: submitted ? new Date(dueDate.getTime() - DAY) : null,
        reviewedAt: done ? dueDate : null, completedAt: done ? dueDate : null,
        patientFeedback: encryptField(task.patientFeedback ?? null), reviewComment: encryptField(task.reviewComment ?? null),
      },
    });
    counts.tasks++;
  }

  for (const assessment of spec.assessments) {
    const scale = CLINICAL_SCALES[assessment.scaleCode];
    if (assessment.answers.length !== scale.questionCount || assessment.answers.some((a) => a < scale.min || a > scale.max)) {
      throw new Error(`Escala de ejemplo mal formada (${scale.code})`);
    }
    const totalScore = assessment.answers.reduce((sum, a) => sum + a, 0);
    const [severity, interpretation] = scale.severity(totalScore);
    await tx.clinicalAssessment.create({
      data: {
        patientId: patient.id, scaleCode: scale.code, scaleName: scale.name,
        answers: encryptJsonField(assessment.answers), result: encryptAssessmentResult({ totalScore, severity, riskFlag: false }),
        interpretation: encryptField(interpretation)!, administeredAt: ago(assessment.daysAgo),
      },
    });
    counts.assessments++;
  }

  if (spec.messages.length) {
    const oldest = Math.max(...spec.messages.map((m) => m.daysAgo));
    const conversation = await tx.conversation.create({
      data: { workspaceId, patientId: patient.id, status: 'OPEN', patientCanReply: true, createdAt: ago(oldest) },
      select: { id: true },
    });
    counts.conversations++;
    for (const [i, message] of spec.messages.entries()) {
      const createdAt = new Date(ago(message.daysAgo).getTime() + i * 60 * 60_000);
      const isLast = i === spec.messages.length - 1;
      await tx.message.create({
        data: {
          conversationId: conversation.id, senderType: message.from, senderUserId: message.from === 'PROFESSIONAL' ? clinicianId : null,
          body: encryptField(message.body)!, createdAt,
          // El último mensaje del paciente queda sin leer para que la bandeja muestre algo pendiente.
          readByProfessionalAt: message.from === 'PATIENT' && isLast ? null : createdAt,
          readByPatientAt: message.from === 'PROFESSIONAL' ? new Date(createdAt.getTime() + 30 * 60_000) : createdAt,
        },
      });
      counts.messages++;
    }
  }

  if (!spec.portal) return null;
  const password = randomPassword();
  await tx.patientPortalAccount.create({
    data: { workspaceId, patientId: patient.id, accessorType: 'PATIENT', email, passwordHash: await hash(password, 12), isActive: true, mustChangePassword: true },
  });
  counts.portalAccounts++;
  return { patient: `${spec.firstName} ${spec.lastName}`, email, password };
}
