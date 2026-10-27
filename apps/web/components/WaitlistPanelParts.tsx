'use client';

import type { PlatformWaitlistResponse } from '@asepsico/contracts';
import Icon from './Icon';
import {
  commercialLabel, commercialTone, Entry, fieldView, Filters, formatSignupDate, hasPhone, phoneView, plural, SITUATION_LABEL, SITUATION_ORDER,
  situationKey, SituationKey, SOURCE_LABEL, SOURCE_ORDER, sourceKey, SourceKey, toggleValue, weekLabel, weekStartShort,
} from '../lib/platform-waitlist';

/** Piezas del panel de la lista de espera (/admin/lista-espera): contadores, filtros, tabla y tarjetas. */

/* ------------------------------- Contadores ------------------------------- */

export function Counters({ data }: { data: PlatformWaitlistResponse }) {
  const { counters } = data;
  const weekly = counters.weekly;
  const thisWeek = weekly[weekly.length - 1]?.count ?? 0;
  const last8 = weekly.reduce((sum, week) => sum + week.count, 0);
  const max = Math.max(1, ...weekly.map((week) => week.count));
  return (
    <>
      <div className="dashboard-metrics wl-metrics">
        <div className="dashboard-card metric-card metric-violet"><span><Icon name="users" /></span><div><strong>{counters.totalActive}</strong><small>Altas activas</small></div></div>
        <div className="dashboard-card metric-card metric-green"><span><Icon name="calendar" /></span><div><strong>{thisWeek}</strong><small>Esta semana</small></div></div>
        <div className="dashboard-card metric-card metric-blue"><span><Icon name="trend" /></span><div><strong>{last8}</strong><small>Últimas 8 semanas</small></div></div>
        <div className="dashboard-card metric-card metric-neutral"><span><Icon name="phone" /></span><div><strong>{counters.withoutPhone}</strong><small>Sin teléfono</small></div></div>
        <div className={`dashboard-card metric-card ${data.unreadable > 0 ? 'metric-amber' : 'metric-neutral'}`}>
          <span><Icon name="info" /></span><div><strong>{data.unreadable}</strong><small>{data.unreadable === 1 ? 'Alta con datos no legibles' : 'Altas con datos no legibles'}</small></div>
        </div>
      </div>

      <div className="wl-breakdowns">
        <section className="dashboard-card wl-panel wl-weekly" aria-labelledby="wl-weekly-title">
          <h2 id="wl-weekly-title">Altas por semana</h2>
          <p className="wl-panel-sub">Últimas 8 semanas, de lunes a domingo (hora de Madrid)</p>
          <ol className="wl-weeks">
            {weekly.map((week, index) => (
              <li key={week.isoWeek} className={index === weekly.length - 1 ? 'is-current' : undefined} title={`${weekLabel(week.isoWeek)}: ${plural(week.count, 'alta', 'altas')}`}>
                <span className="wl-week-value">{week.count}</span>
                <span className="wl-week-track" aria-hidden="true"><span className="wl-week-bar" style={{ height: `${week.count === 0 ? 0 : Math.max(6, (week.count / max) * 100)}%` }} /></span>
                <span className="wl-week-label"><span className="sr-only">{weekLabel(week.isoWeek)}: </span><span aria-hidden="true">{weekStartShort(week.weekStart)}</span></span>
              </li>
            ))}
          </ol>
        </section>
        <Breakdown title="Por origen" id="wl-source-title" order={SOURCE_ORDER} labels={SOURCE_LABEL} counts={counters.bySource} total={counters.totalActive} />
        <Breakdown title="Por situación" id="wl-situation-title" order={SITUATION_ORDER} labels={SITUATION_LABEL} counts={counters.bySituation} total={counters.totalActive} />
      </div>
    </>
  );
}

function Breakdown<K extends string>({ title, id, order, labels, counts, total }: { title: string; id: string; order: K[]; labels: Record<K, string>; counts: Record<K, number>; total: number }) {
  return (
    <section className="dashboard-card wl-panel" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="wl-bars">
        {order.map((key) => {
          const count = counts[key] ?? 0;
          const share = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <li key={key} className={count === 0 ? 'is-zero' : undefined}>
              <span className="wl-bar-label">{labels[key]}</span>
              <span className="wl-bar-value">{count}{count > 0 && <small> · {share}%</small>}</span>
              <span className="wl-bar-track" aria-hidden="true"><span style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------- Filtros ------------------------------- */

export function FiltersBar({ filters, weeks, onChange, counts }: { filters: Filters; weeks: string[]; onChange: (next: Filters) => void; counts: PlatformWaitlistResponse['counters'] }) {
  return (
    <div className="wl-filters" role="group" aria-label="Filtrar altas">
      <fieldset className="wl-filter">
        <legend>Origen</legend>
        <div className="wl-chips">
          {SOURCE_ORDER.filter((key) => counts.bySource[key] > 0 || filters.sources.includes(key)).map((key: SourceKey) => (
            <button key={key} type="button" className="wl-chip" aria-pressed={filters.sources.includes(key)} onClick={() => onChange({ ...filters, sources: toggleValue(filters.sources, key) })}>
              {filters.sources.includes(key) && <Icon name="check" size={14} />}{SOURCE_LABEL[key]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="wl-filter">
        <legend>Situación</legend>
        <div className="wl-chips">
          {SITUATION_ORDER.filter((key) => counts.bySituation[key] > 0 || filters.situations.includes(key)).map((key: SituationKey) => (
            <button key={key} type="button" className="wl-chip" aria-pressed={filters.situations.includes(key)} onClick={() => onChange({ ...filters, situations: toggleValue(filters.situations, key) })}>
              {filters.situations.includes(key) && <Icon name="check" size={14} />}{SITUATION_LABEL[key]}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="ps-filter wl-week-filter">
        <span>Semana</span>
        <select value={filters.week} onChange={(event) => onChange({ ...filters, week: event.target.value })}>
          <option value="">Todas las semanas</option>
          {weeks.map((week) => <option key={week} value={week}>{weekLabel(week)}</option>)}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------- Tabla y tarjetas ------------------------------- */

function Field({ entry, field, className }: { entry: Entry; field: 'name' | 'email' | 'tools'; className?: string }) {
  const view = fieldView(entry, field);
  if (view.unreadable) return <span className="wl-unreadable" title="No se ha podido descifrar este dato">{view.text}</span>;
  return <span className={[className, view.text === '—' ? 'wl-muted' : ''].filter(Boolean).join(' ') || undefined} title={view.title}>{view.text}</span>;
}

/** Enlace tel: con el número agrupado; «Sin teléfono» en gris; «No legible» como los demás campos. */
function Phone({ entry, prominent }: { entry: Entry; prominent?: boolean }) {
  const view = phoneView(entry);
  if (view.kind === 'unreadable') return <span className="wl-unreadable" title="No se ha podido descifrar este dato">{view.text}</span>;
  if (view.kind === 'none') return <span className="wl-muted wl-no-phone">{view.text}</span>;
  return (
    <a className={prominent ? 'wl-phone wl-phone-prominent' : 'wl-phone'} href={view.href}>
      <Icon name="phone" size={prominent ? 18 : 16} />
      <span>{view.text}</span>
    </a>
  );
}

type Actions = { onSuppress: (entry: Entry) => void; onDeletePhone: (entry: Entry) => void };

function Commercial({ entry }: { entry: Entry }) {
  const tone = commercialTone(entry.commercial);
  const label = commercialLabel(entry.commercial);
  if (tone === 'none') return <span className="wl-muted" aria-label="No solicitado">—</span>;
  return <span className={`ui-chip chip-${tone}`}>{label}</span>;
}

function Professionals({ entry }: { entry: Entry }) {
  return entry.professionalsCount == null ? <span className="wl-muted">—</span> : <>{entry.professionalsCount}</>;
}

/** "v4" a la vista; la versión completa (lista-espera-v4) en el tooltip y para lectores de pantalla. */
function PolicyVersion({ version }: { version: string }) {
  const short = version.replace(/^lista-espera-/, '');
  return <code className="wl-version" title={version}><span aria-hidden="true">{short}</span><span className="sr-only">{version}</span></code>;
}

function DateCell({ iso }: { iso: string }) {
  const [day, time] = formatSignupDate(iso).split(' ');
  return <><span className="wl-date-day">{day}</span><span className="wl-date-time">{time}</span></>;
}

export function EntriesTable({ entries, onSuppress, onDeletePhone }: { entries: Entry[] } & Actions) {
  return (
    <div className="wl-table-wrap">
      <table className="wl-table">
        <caption className="sr-only">Altas de la lista de espera, de la más reciente a la más antigua</caption>
        <thead>
          <tr>
            <th scope="col">Fecha de alta</th>
            <th scope="col">Persona</th>
            <th scope="col">Teléfono</th>
            <th scope="col">Situación</th>
            <th scope="col" className="wl-num">Prof.</th>
            <th scope="col">Herramientas</th>
            <th scope="col">Origen</th>
            <th scope="col">Política</th>
            <th scope="col">Comercial</th>
            <th scope="col"><span className="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="wl-date"><DateCell iso={entry.createdAt} /></td>
              <td className="wl-person">
                <Field entry={entry} field="name" className="wl-name" />
                <Field entry={entry} field="email" className="wl-email" />
              </td>
              <td className="wl-phone-cell">
                <Phone entry={entry} />
                {hasPhone(entry) && (
                  <button type="button" className="wl-delete-phone" onClick={() => onDeletePhone(entry)}>
                    Borrar solo el teléfono<span className="sr-only"> del alta del {formatSignupDate(entry.createdAt)}</span>
                  </button>
                )}
              </td>
              <td>{SITUATION_LABEL[situationKey(entry)]}</td>
              <td className="wl-num"><Professionals entry={entry} /></td>
              <td className="wl-tools"><Field entry={entry} field="tools" /></td>
              <td>{SOURCE_LABEL[sourceKey(entry)]}</td>
              <td><PolicyVersion version={entry.privacyPolicyVersion} /></td>
              <td><Commercial entry={entry} /></td>
              <td className="wl-actions">
                <button type="button" className="wl-suppress" onClick={() => onSuppress(entry)}>
                  Suprimir<span className="sr-only"> el alta del {formatSignupDate(entry.createdAt)}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EntryCard({ entry, onSuppress, onDeletePhone }: { entry: Entry } & Actions) {
  return (
    <li className="wl-card">
      <div className="wl-card-top">
        <div className="wl-person">
          <Field entry={entry} field="name" className="wl-name" />
          <Field entry={entry} field="email" className="wl-email" />
        </div>
        <span className="wl-card-date">{formatSignupDate(entry.createdAt)}</span>
      </div>
      <div className="wl-card-phone"><Phone entry={entry} prominent /></div>
      <dl className="wl-card-grid">
        <div><dt>Situación</dt><dd>{SITUATION_LABEL[situationKey(entry)]}</dd></div>
        <div><dt>Profesionales</dt><dd><Professionals entry={entry} /></dd></div>
        <div><dt>Origen</dt><dd>{SOURCE_LABEL[sourceKey(entry)]}</dd></div>
        <div><dt>Política</dt><dd><code className="wl-version">{entry.privacyPolicyVersion}</code></dd></div>
        <div className="wl-card-wide"><dt>Herramientas</dt><dd><Field entry={entry} field="tools" /></dd></div>
        <div className="wl-card-wide"><dt>Comunicaciones comerciales</dt><dd><Commercial entry={entry} /></dd></div>
      </dl>
      <div className="wl-card-actions">
        {hasPhone(entry) && (
          <button type="button" className="wl-delete-phone" onClick={() => onDeletePhone(entry)}>
            Borrar solo el teléfono<span className="sr-only"> del alta del {formatSignupDate(entry.createdAt)}</span>
          </button>
        )}
        <button type="button" className="wl-suppress" onClick={() => onSuppress(entry)}>
          Suprimir alta<span className="sr-only"> del {formatSignupDate(entry.createdAt)}</span>
        </button>
      </div>
    </li>
  );
}
