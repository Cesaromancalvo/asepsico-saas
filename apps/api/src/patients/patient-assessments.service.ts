import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { encryptField } from '../common/crypto/field-encryption';
import { decryptAssessment, encryptAssessmentResult, encryptJsonField } from '../common/crypto/clinical-crypto';
import { PatientAccessService } from './patient-access.service';
import { assertScopedWrite, patientChildScope } from './patient-write.util';
import { CreateClinicalAssessmentDto } from './dto/create-clinical-assessment.dto';

const CLINICAL_SCALES = {
  PHQ9: {
    code: 'PHQ9', name: 'PHQ-9', questionCount: 9, min: 0, max: 3,
    severity(score: number) {
      if (score <= 4) return ['Mínima', 'Síntomas depresivos mínimos.'];
      if (score <= 9) return ['Leve', 'Sintomatología depresiva leve; valorar seguimiento clínico.'];
      if (score <= 14) return ['Moderada', 'Sintomatología depresiva moderada.'];
      if (score <= 19) return ['Moderadamente grave', 'Sintomatología depresiva moderadamente grave.'];
      return ['Grave', 'Sintomatología depresiva grave; requiere valoración clínica prioritaria.'];
    },
  },
  GAD7: {
    code: 'GAD7', name: 'GAD-7', questionCount: 7, min: 0, max: 3,
    severity(score: number) {
      if (score <= 4) return ['Mínima', 'Síntomas de ansiedad mínimos.'];
      if (score <= 9) return ['Leve', 'Sintomatología ansiosa leve; valorar seguimiento.'];
      if (score <= 14) return ['Moderada', 'Sintomatología ansiosa moderada.'];
      return ['Grave', 'Sintomatología ansiosa grave; requiere valoración clínica.'];
    },
  },
  WHO5: {
    code: 'WHO5', name: 'WHO-5', questionCount: 5, min: 0, max: 5,
    severity(score: number) {
      const percentage = score * 4;
      if (percentage >= 72) return ['Bienestar alto', `Índice de bienestar ${percentage}/100.`];
      if (percentage >= 52) return ['Bienestar adecuado', `Índice de bienestar ${percentage}/100.`];
      if (percentage >= 28) return ['Bienestar reducido', `Índice de bienestar ${percentage}/100; conviene exploración clínica.`];
      return ['Bienestar muy reducido', `Índice de bienestar ${percentage}/100; valorar síntomas depresivos.`];
    },
  },
} as const;

// answers (Json), interpretation y clinicalNotes se cifran en reposo; ver
// common/crypto/clinical-crypto.ts (encryptJsonField / decryptAssessment).
// totalScore, severity y riskFlag se guardan cifrados juntos en `result` (decisión del Jefe);
// las columnas en claro son legado y ya no se escriben (quedan NULL).
function encryptAnswers(answers: number[]): string {
  return encryptJsonField(answers);
}

@Injectable()
export class PatientAssessmentsService {
  constructor(private readonly prisma: PrismaService, private readonly access: PatientAccessService) {}

  async getAssessmentCatalog(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    return [
      { code: 'PHQ9', name: 'PHQ-9', domain: 'Depresión', questionCount: 9, answerMin: 0, answerMax: 3 },
      { code: 'GAD7', name: 'GAD-7', domain: 'Ansiedad', questionCount: 7, answerMin: 0, answerMax: 3 },
      { code: 'WHO5', name: 'WHO-5', domain: 'Bienestar', questionCount: 5, answerMin: 0, answerMax: 5 },
    ];
  }

  async getClinicalAssessments(workspaceId: string, actor: AuthUser, patientId: string) {
    await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    // Acotado también al workspace por la relación patient (defensa en profundidad).
    const assessments = await this.prisma.clinicalAssessment.findMany({
      where: patientChildScope(workspaceId, patientId),
      orderBy: [{ administeredAt: 'desc' }, { createdAt: 'desc' }],
    });
    return assessments.map(decryptAssessment);
  }

  async createClinicalAssessment(workspaceId: string, actor: AuthUser, patientId: string, dto: CreateClinicalAssessmentDto) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scale = CLINICAL_SCALES[dto.scaleCode];
    if (dto.answers.length !== scale.questionCount) {
      throw new BadRequestException(`La escala ${scale.name} requiere ${scale.questionCount} respuestas`);
    }
    if (dto.answers.some((answer) => answer < scale.min || answer > scale.max)) {
      throw new BadRequestException(`Las respuestas de ${scale.name} deben estar entre ${scale.min} y ${scale.max}`);
    }
    const totalScore = dto.answers.reduce((sum, answer) => sum + answer, 0);
    const riskFlag = dto.scaleCode === 'PHQ9' && dto.answers[8] > 0;
    const [severity, baseInterpretation] = scale.severity(totalScore);
    const interpretation = riskFlag
      ? `${baseInterpretation} La respuesta al ítem 9 requiere valoración clínica inmediata conforme al protocolo del centro.`
      : baseInterpretation;
    return this.prisma.$transaction(async (tx) => {
      const assessment = await tx.clinicalAssessment.create({
        data: {
          patientId,
          scaleCode: scale.code,
          scaleName: scale.name,
          answers: encryptAnswers(dto.answers),
          result: encryptAssessmentResult({ totalScore, severity, riskFlag }),
          interpretation: encryptField(interpretation)!,
          clinicalNotes: encryptField(dto.clinicalNotes?.trim() || null),
          administeredAt: dto.administeredAt ? new Date(dto.administeredAt) : new Date(),
        },
      });
      await tx.auditLog.create({ data: {
        workspaceId, actorId: actor.sub, action: 'CLINICAL_ASSESSMENT_CREATED',
        entityType: 'ClinicalAssessment', entityId: assessment.id,
        // Sin puntuación, gravedad ni alerta de riesgo: ahora son contenido cifrado y el
        // audit log (en claro) no debe copiarlos. Solo qué escala se pasó y a quién.
        metadata: { patientId, scaleCode: scale.code },
      }});
      return decryptAssessment(assessment);
    });
  }

  async deleteClinicalAssessment(workspaceId: string, actor: AuthUser, patientId: string, assessmentId: string) {
    const patient = await this.access.assertPatientClinicalAccess(workspaceId, actor, patientId);
    if (patient.status === 'ARCHIVED') throw new BadRequestException('El paciente está archivado');
    const scope = { id: assessmentId, ...patientChildScope(workspaceId, patientId) };
    const existing = await this.prisma.clinicalAssessment.findFirst({ where: scope });
    if (!existing) throw new NotFoundException('Evaluación clínica no encontrada');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.clinicalAssessment.deleteMany({ where: scope });
      await assertScopedWrite(count, 'Evaluación clínica no encontrada');
      await tx.auditLog.create({ data: {
        workspaceId, actorId: actor.sub, action: 'CLINICAL_ASSESSMENT_DELETED',
        entityType: 'ClinicalAssessment', entityId: assessmentId,
        metadata: { patientId, scaleCode: existing.scaleCode },
      }});
    });
    return { success: true };
  }
}
