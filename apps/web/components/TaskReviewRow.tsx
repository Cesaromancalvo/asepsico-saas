import Link from 'next/link';

type Props = { href: string; title: string; subtitle: string };

/**
 * Fila de «Tareas por revisar» (/follow-up/revisar): título y paciente ocupan todo el ancho
 * disponible y «Revisar» queda a la derecha (debajo en móvil). Usa su propia rejilla
 * (`.review-task-row`) en lugar de la de tres columnas de `.task-row` de Mi jornada, que reserva
 * 36 px para un icono a la izquierda: sin icono, el título caía en esa columna, una palabra por línea.
 */
export default function TaskReviewRow({ href, title, subtitle }: Props) {
  return (
    <Link href={href} className="task-row review-task-row">
      <span className="review-task-copy"><strong>{title}</strong><small>{subtitle}</small></span>
      <span className="review-task-action">Revisar</span>
    </Link>
  );
}
