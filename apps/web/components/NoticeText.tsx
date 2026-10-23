import { NoticeVariables, PENDING_PRACTICE_DATA, PENDING_VARIABLES, RichText } from '@/lib/portal-signup-texts';

/** Pinta un texto legal con sus variables; las pendientes, como marcador visible. */
export default function NoticeText({ text, vars = PENDING_VARIABLES }: { text: RichText; vars?: NoticeVariables }) {
  return (
    <>
      {text.map((part, index) => {
        if (typeof part === 'string') return <span key={index}>{part}</span>;
        const value = vars[part.variable];
        return value ? <span key={index}>{value}</span> : <span key={index} className="ps-var">{PENDING_PRACTICE_DATA}</span>;
      })}
    </>
  );
}
