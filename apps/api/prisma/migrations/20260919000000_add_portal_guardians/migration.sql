-- Nuevos tipos para el modo de acceso al portal (elegido por el profesional según
-- edad/madurez del paciente) y quién es cada cuenta (el propio paciente o un tutor).
CREATE TYPE "PortalAccessMode" AS ENUM ('PATIENT_ONLY', 'GUARDIAN_ONLY', 'SHARED');
CREATE TYPE "PortalAccessorType" AS ENUM ('PATIENT', 'GUARDIAN');

-- El profesional decide, por paciente, quién puede tener cuenta en el portal.
ALTER TABLE "Patient" ADD COLUMN "portalAccessMode" "PortalAccessMode" NOT NULL DEFAULT 'PATIENT_ONLY';

-- PatientPortalAccount deja de ser "una cuenta por paciente" para admitir varias: la del
-- propio paciente y, por separado, la de cada tutor (cuentas independientes a propósito,
-- para no asumir que ambos progenitores deben ver siempre lo mismo).
ALTER TABLE "PatientPortalAccount" DROP CONSTRAINT IF EXISTS "PatientPortalAccount_patientId_key";
ALTER TABLE "PatientPortalAccount" ADD COLUMN "accessorType" "PortalAccessorType" NOT NULL DEFAULT 'PATIENT';
ALTER TABLE "PatientPortalAccount" ADD COLUMN "guardianName" TEXT;
ALTER TABLE "PatientPortalAccount" ADD COLUMN "guardianRelationship" TEXT;
CREATE INDEX "PatientPortalAccount_patientId_idx" ON "PatientPortalAccount"("patientId");
