'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SampleDataStatusContract } from '@asepsico/contracts';
import type { Viewer } from '@/lib/clinical';
import { useIsDemoEnvironment } from '@/lib/environment';
import {
  isSampleNoticeDismissed,
  loadSampleDataStatus,
  SAMPLE_DATA_SETTINGS_HREF,
  SAMPLE_NOTICE_CLINICIAN,
  SAMPLE_NOTICE_NO_REAL_DATA,
  SAMPLE_NOTICE_TITLE,
  SAMPLE_NOTICE_WITH_DEMO_BANNER,
  setSampleNoticeDismissed,
  shouldShowSampleNotice,
} from '@/lib/sample-data';

type ViewProps = {
  /** Ya se ve el aviso fijo «Entorno de prueba»: no se repite «No introduzcas datos reales». */
  demoBanner: boolean;
  dismissed: boolean;
  onDismiss: () => void;
  onReopen: () => void;
};

/**
 * Aviso de espacio de prueba en Mi jornada (presentación). Se puede cerrar, pero queda una línea
 * con el enlace a «Datos de ejemplo» para volver a encontrarlo.
 */
export function SampleDataNoticeView({ demoBanner, dismissed, onDismiss, onReopen }: ViewProps) {
  if (dismissed) {
    return (
      <p className="sample-notice-compact">
        <span className="sample-notice-dot" aria-hidden="true" />
        Espacio de prueba con pacientes inventados.{' '}
        <Link href={SAMPLE_DATA_SETTINGS_HREF}>Datos de ejemplo</Link>
        <span aria-hidden="true"> · </span>
        <button type="button" className="bk-link-button" onClick={onReopen}>Ver el aviso</button>
      </p>
    );
  }
  return (
    <section className="e1-notice info sample-notice" role="note" aria-labelledby="sample-notice-title">
      <div>
        <strong id="sample-notice-title">{SAMPLE_NOTICE_TITLE}</strong>
        {/* [LEX/CLIO] texto pendiente de validar */}
        <p>{demoBanner ? SAMPLE_NOTICE_WITH_DEMO_BANNER : SAMPLE_NOTICE_NO_REAL_DATA}</p>
        <p>{SAMPLE_NOTICE_CLINICIAN}</p>
      </div>
      <div className="e1-notice-actions">
        <Link href={SAMPLE_DATA_SETTINGS_HREF} className="search-action">Ver el portal o borrar los datos</Link>
        <button type="button" className="sample-notice-close" aria-label="Cerrar el aviso de espacio de prueba" onClick={onDismiss}>×</button>
      </div>
    </section>
  );
}

/**
 * Aviso de espacio de prueba (E1): solo para OWNER, solo si se cargaron datos de ejemplo y no se
 * han borrado. Para el resto de roles no pide nada a la API ni pinta nada.
 */
export default function SampleDataNotice({ viewer }: { viewer: Viewer }) {
  const demoBanner = useIsDemoEnvironment();
  const [status, setStatus] = useState<SampleDataStatusContract | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const role = viewer.role;
  const scope = viewer.userId;

  useEffect(() => {
    let cancelled = false;
    setDismissed(isSampleNoticeDismissed(scope));
    // Un fallo al leer el estado no rompe Mi jornada: simplemente no se pinta el aviso
    // (el aviso fijo «Entorno de prueba» sigue a la vista).
    loadSampleDataStatus(role).then((value) => { if (!cancelled) setStatus(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [role, scope]);

  if (!shouldShowSampleNotice(role, status)) return null;

  return (
    <SampleDataNoticeView
      demoBanner={demoBanner}
      dismissed={dismissed}
      onDismiss={() => { setDismissed(true); setSampleNoticeDismissed(scope, true); }}
      onReopen={() => { setDismissed(false); setSampleNoticeDismissed(scope, false); }}
    />
  );
}
