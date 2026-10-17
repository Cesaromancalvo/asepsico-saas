'use client';

import { useId, useState } from 'react';
import type { AvailabilityWindowContract } from '@asepsico/contracts';
import { addWindowToDay, copyDayWindows, minuteToTime, WEEKDAYS } from '@/lib/booking';

/** Opciones de hora cada 15 minutos (el fin admite las 24:00). */
const START_OPTIONS = Array.from({ length: 96 }, (_, i) => i * 15);
const END_OPTIONS = Array.from({ length: 96 }, (_, i) => (i + 1) * 15);

type Props = {
  windows: AvailabilityWindowContract[];
  onChange: (windows: AvailabilityWindowContract[]) => void;
  disabled?: boolean;
};

/**
 * Franjas semanales: por cada día, una o varias franjas "desde - hasta" (por ejemplo 09:00-14:00 y
 * 16:00-20:00). Las horas se eligen en intervalos de 15 minutos con listas desplegables, que
 * funcionan bien con teclado, lector de pantalla y móvil. Un descanso se hace partiendo la franja.
 */
export default function WeeklyWindows({ windows, onChange, disabled }: Props) {
  const ids = useId();
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);

  function update(index: number, patch: Partial<AvailabilityWindowContract>) {
    onChange(windows.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  }

  function toggleTarget(day: number) {
    setCopyTargets((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));
  }

  function applyCopy(from: number, targets: number[]) {
    if (targets.length) onChange(copyDayWindows(windows, from, targets));
    setCopyFrom(null);
    setCopyTargets([]);
  }

  return (
    <div className="bk-week">
      {WEEKDAYS.map((day) => {
        const rows = windows.map((w, index) => ({ w, index })).filter((row) => row.w.weekday === day.n);
        const copying = copyFrom === day.n;
        return (
          <fieldset key={day.n} className="bk-day-row" disabled={disabled}>
            <legend>{day.label}</legend>
            {rows.length === 0 && <p className="bk-closed">Sin consulta</p>}
            {rows.map(({ w, index }, position) => (
              <div key={index} className="bk-window">
                <label>
                  <span className="bk-sr">{day.label}, franja {position + 1}: desde</span>
                  <span aria-hidden="true" className="bk-window-label">Desde</span>
                  <select value={w.startMinute} onChange={(e) => update(index, { startMinute: Number(e.target.value) })}>
                    {START_OPTIONS.map((m) => <option key={m} value={m}>{minuteToTime(m)}</option>)}
                  </select>
                </label>
                <label>
                  <span className="bk-sr">{day.label}, franja {position + 1}: hasta</span>
                  <span aria-hidden="true" className="bk-window-label">Hasta</span>
                  <select value={w.endMinute} onChange={(e) => update(index, { endMinute: Number(e.target.value) })}>
                    {END_OPTIONS.map((m) => <option key={m} value={m}>{minuteToTime(m)}</option>)}
                  </select>
                </label>
                <button type="button" className="bk-link-button" onClick={() => onChange(windows.filter((_, i) => i !== index))} aria-label={`Quitar la franja ${position + 1} del ${day.label.toLowerCase()}`}>
                  Quitar
                </button>
              </div>
            ))}
            <div className="bk-day-actions">
              <button type="button" className="button secondary bk-small" onClick={() => onChange(addWindowToDay(windows, day.n))}>
                Añadir franja
              </button>
              {rows.length > 0 && (
                <button
                  type="button"
                  className="bk-link-button"
                  aria-expanded={copying}
                  aria-controls={`${ids}-copy-${day.n}`}
                  onClick={() => { setCopyFrom(copying ? null : day.n); setCopyTargets([]); }}
                >
                  Copiar a otros días
                </button>
              )}
            </div>
            {copying && (
              <div id={`${ids}-copy-${day.n}`} className="bk-copy" role="group" aria-label={`Copiar las franjas del ${day.label.toLowerCase()}`}>
                <p>Se sustituirán las franjas que ya tengan esos días.</p>
                <div className="bk-copy-days">
                  {WEEKDAYS.filter((d) => d.n !== day.n).map((d) => (
                    <label key={d.n} className="bk-check">
                      <input type="checkbox" checked={copyTargets.includes(d.n)} onChange={() => toggleTarget(d.n)} />
                      <span>{d.label}</span>
                    </label>
                  ))}
                </div>
                <div className="bk-actions">
                  <button type="button" className="button secondary bk-small" onClick={() => applyCopy(day.n, [1, 2, 3, 4, 5])}>De lunes a viernes</button>
                  <button type="button" className="button bk-small" disabled={!copyTargets.length} onClick={() => applyCopy(day.n, copyTargets)}>Copiar</button>
                </div>
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
