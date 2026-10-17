'use client';

import Link from 'next/link';
import { ReactNode } from 'react';
import Sidebar from '@/components/Sidebar';
import { isStaffWithProcessAccess, PatientClinicalAccess, usePatientClinicalAccess, useViewer, Viewer } from '@/lib/clinical';

export type SubpageMode = 'loading' | 'treating' | 'blocked';

/**
 * Subpáginas clínicas con escritura (tareas, escalas): solo con TREATING (proceso ACTIVO propio o
 * de un paciente que trata). Con acceso excepcional, como autor de un proceso cerrado o sin
 * relación, NO se pintan: ni notas internas ni controles de editar o borrar. La lectura en esos
 * casos está en la ficha (solo lectura) y en el detalle del proceso.
 */
export function subpageMode(viewer: Viewer | null, access: PatientClinicalAccess): SubpageMode {
  if (!viewer) return 'loading';
  if (!isStaffWithProcessAccess(viewer.role)) return 'blocked';
  if (access.state === 'loading') return 'loading';
  return access.state === 'ready' && access.treating ? 'treating' : 'blocked';
}

export function ClinicalSubpageView({ mode, patientId, section, children }: { mode: SubpageMode; patientId: string; section: string; children: ReactNode }) {
  if (mode === 'treating') return <>{children}</>;
  return (
    <div className="app-layout"><Sidebar /><main className="patient-record-page">
      {mode === 'loading' ? <div className="patient-record-loading" role="status">Cargando…</div> : (
        <>
          <Link href={`/patients/${patientId}`} className="patient-record-back">← Volver a la ficha</Link>
          <div className="e1-notice info" role="note">
            <div>
              <strong>{section}: solo para quien atiende al paciente</strong>
              <p>Esta sección la usa el profesional que atiende al paciente. Si tienes un acceso excepcional, la información que puedes consultar está en la ficha, en solo lectura.</p>
            </div>
            <div className="e1-notice-actions"><Link href={`/patients/${patientId}`} className="button secondary">Ir a la ficha</Link></div>
          </div>
        </>
      )}
    </main></div>
  );
}

/** Envuelve la página: el contenido (y sus peticiones) solo se monta con TREATING. */
export default function ClinicalSubpageGate({ patientId, section, children }: { patientId: string; section: string; children: ReactNode }) {
  const viewer = useViewer();
  const { access } = usePatientClinicalAccess(patientId, viewer !== null && isStaffWithProcessAccess(viewer.role));
  return <ClinicalSubpageView mode={subpageMode(viewer, access)} patientId={patientId} section={section}>{children}</ClinicalSubpageView>;
}
