import { describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PortalAppointmentRequestContract, PortalBookingOptionsContract, StaffAppointmentRequestContract,
} from '@asepsico/contracts';
import { BookingPanel, BookingPanelProps, RequestsList, SlotPicker } from '../components/PortalBooking';
import PortalBookingToggle from '../components/PortalBookingToggle';
import RequestCard from '../components/RequestCard';
import WeeklyWindows from '../components/WeeklyWindows';

const noop = () => undefined;
const ana = { id: 'th1', firstName: 'Ana', lastName: 'García' };

const options = (patch: Partial<PortalBookingOptionsContract> = {}): PortalBookingOptionsContract => ({
  canBook: true,
  message: null,
  emergencyNotice: 'Esto no es un canal de urgencias. Si lo necesitas, llama al 024 o al 112.',
  therapists: [ana],
  appointments: [],
  ...patch,
});

const slots = {
  therapist: ana,
  timeZone: 'Europe/Madrid',
  slots: [
    { startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T09:50:00.000Z' },
    { startsAt: '2026-11-05T10:00:00.000Z', endsAt: '2026-11-05T10:50:00.000Z' },
    { startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-10T09:50:00.000Z' },
  ],
};

const panel = (patch: Partial<BookingPanelProps> = {}): BookingPanelProps => ({
  options: options(), requests: [], slots, slotsState: 'ready', therapistId: 'th1', busy: false, notice: '', error: '', rescheduleOf: null,
  onTherapist: noop, onStartReschedule: noop, onStopReschedule: noop, onSubmitSlot: noop, onCancelAppointment: noop, onWithdraw: noop, onRetrySlots: noop,
  ...patch,
});

const portalRequest = (patch: Partial<PortalAppointmentRequestContract>): PortalAppointmentRequestContract => ({
  id: 'r1', type: 'NEW', status: 'PENDING', startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T09:50:00.000Z', sessionId: null,
  rejectionReason: null, expiresAt: '2026-11-04T09:00:00.000Z', createdAt: '2026-10-20T09:00:00.000Z', resolvedAt: null, therapist: ana, ...patch,
});

describe('Portal: Pedir cita', () => {
  it('con la reserva no activa no se pinta nada ni se explica por qué', () => {
    const html = renderToStaticMarkup(<BookingPanel {...panel({ options: options({ canBook: false, message: 'Para pedir cita, contacta con la consulta.', therapists: [] }) })} />);
    expect(html).toBe('');
  });

  it('con la reserva activa enseña el calendario, el aviso de urgencias y Mis solicitudes', () => {
    const html = renderToStaticMarkup(<BookingPanel {...panel()} />);
    expect(html).toContain('Pedir cita');
    expect(html).toContain('Mis solicitudes');
    expect(html).toContain('024');
    expect(html).toContain('noviembre de 2026');
    expect(html).toContain('Todavía no has pedido ninguna cita');
    // Un profesional: no hace falta elegir con quién.
    expect(html).not.toContain('¿Con quién quieres pedir cita?');
    expect(html).toContain('Con Ana García');
  });

  it('con dos profesionales primero se elige con quién', () => {
    const html = renderToStaticMarkup(<BookingPanel {...panel({ options: options({ therapists: [ana, { id: 'th2', firstName: 'Luis', lastName: 'Pérez' }] }) })} />);
    expect(html).toContain('¿Con quién quieres pedir cita?');
    expect(html).toContain('Luis Pérez');
  });

  it('cubre carga, error y vacío de los huecos', () => {
    expect(renderToStaticMarkup(<BookingPanel {...panel({ slots: null, slotsState: 'loading' })} />)).toContain('Buscando horas libres');
    const failed = renderToStaticMarkup(<BookingPanel {...panel({ slots: null, slotsState: 'error' })} />);
    expect(failed).toContain('No hemos podido cargar las horas libres');
    expect(failed).toContain('Intentar de nuevo');
    const empty = renderToStaticMarkup(<BookingPanel {...panel({ slots: { ...slots, slots: [] } })} />);
    expect(empty).toContain('Ahora mismo no hay horas libres');
  });

  it('muestra el aviso de éxito y el error con el rol correcto para lectores de pantalla', () => {
    const html = renderToStaticMarkup(<BookingPanel {...panel({ notice: 'Solicitud enviada. La consulta te confirmará la cita.', error: 'Ya tienes una solicitud pendiente.' })} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Solicitud enviada. La consulta te confirmará la cita.');
    expect(html).toContain('role="alert"');
  });

  it('ofrece cambiar o cancelar solo si falta más que el plazo y no hay otra solicitud en curso', () => {
    const appointments = [
      { id: 's1', startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:50:00.000Z', therapist: ana, changeAllowed: true, hasPendingRequest: false },
      { id: 's2', startsAt: '2026-10-21T09:00:00.000Z', endsAt: '2026-10-21T09:50:00.000Z', therapist: ana, changeAllowed: false, hasPendingRequest: false },
      { id: 's3', startsAt: '2026-11-19T09:00:00.000Z', endsAt: '2026-11-19T09:50:00.000Z', therapist: ana, changeAllowed: false, hasPendingRequest: true },
    ];
    const html = renderToStaticMarkup(<BookingPanel {...panel({ options: options({ appointments }) })} />);
    expect(html.match(/Pedir otro día u hora/g)).toHaveLength(1);
    expect(html.match(/Pedir cancelación/g)).toHaveLength(1);
    expect(html).toContain('Falta poco para esta cita. Si necesitas cambiarla, llama a la consulta.');
    expect(html).toContain('Solicitud en curso');
  });

  it('al cambiar una cita explica que la actual sigue en pie y ofrece dejarla como está', () => {
    const appointment = { id: 's1', startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:50:00.000Z', therapist: ana, changeAllowed: true, hasPendingRequest: false };
    const html = renderToStaticMarkup(<BookingPanel {...panel({ options: options({ appointments: [appointment] }), rescheduleOf: appointment })} />);
    expect(html).toContain('Cambiar tu cita');
    expect(html).toContain('sigue en pie');
    expect(html).toContain('Dejar mi cita como está');
    expect(html).not.toContain('Cambiar o cancelar una cita');
  });
});

describe('Portal: calendario', () => {
  it('solo los días con huecos se pueden pulsar y todos tienen nombre accesible', () => {
    const html = renderToStaticMarkup(<SlotPicker slots={slots.slots} timeZone="Europe/Madrid" selected={null} onSelect={noop} />);
    expect(html).toContain('jueves 5 de noviembre, hay horas libres');
    expect(html).toContain('martes 10 de noviembre, hay horas libres');
    expect(html).toContain('viernes 6 de noviembre, sin horas libres');
    expect(html.match(/has-slots/g)).toHaveLength(2);
    // Los días sin huecos van deshabilitados.
    expect(html.match(/disabled=""/g)!.length).toBeGreaterThan(20);
    expect(html).toContain('Toca un día marcado');
  });
});

describe('Portal: Mis solicitudes', () => {
  const render = (requests: PortalAppointmentRequestContract[]) => renderToStaticMarkup(<RequestsList requests={requests} appointments={[]} busy={false} onWithdraw={noop} />);

  it('estado vacío', () => {
    expect(render([])).toContain('Todavía no has pedido ninguna cita');
  });

  it('pendiente: se puede retirar; el resto, no', () => {
    expect(render([portalRequest({})])).toContain('Retirar solicitud');
    expect(render([portalRequest({ status: 'APPROVED' })])).not.toContain('Retirar solicitud');
    expect(render([portalRequest({ status: 'WITHDRAWN' })])).not.toContain('Retirar solicitud');
  });

  it('rechazada: enseña el motivo de la lista cerrada; caducada: invita a pedir otra hora', () => {
    const rejected = render([portalRequest({ status: 'REJECTED', rejectionReason: 'CONTACT_PRACTICE' })]);
    expect(rejected).toContain('Rechazada');
    expect(rejected).toContain('Contacta con la consulta.');
    const expired = render([portalRequest({ status: 'EXPIRED' })]);
    expect(expired).toContain('Caducada');
    expect(expired).toContain('pedir otra hora');
    expect(render([portalRequest({ status: 'APPROVED' })])).toContain('Aprobada');
  });
});

const staffRequest = (patch: Partial<StaffAppointmentRequestContract>): StaffAppointmentRequestContract => ({
  id: 'q1', type: 'NEW', status: 'PENDING', startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T09:50:00.000Z', sessionId: null,
  accessorType: 'PATIENT', rejectionReason: null, expiresAt: '2026-11-04T09:00:00.000Z', createdAt: '2026-10-20T09:00:00.000Z', resolvedAt: null,
  patient: { id: 'p1', firstName: 'Paciente', lastName: 'Ficticio' }, therapist: ana, session: null, ...patch,
});

describe('Bandeja: solicitudes de cita', () => {
  const render = (request: StaffAppointmentRequestContract, showTherapist = false) =>
    renderToStaticMarkup(<RequestCard request={request} showTherapist={showTherapist} busy={false} onApprove={noop} onReject={noop} />);

  it('una solicitud nueva se acepta o se rechaza con un clic', () => {
    const html = render(staffRequest({}));
    expect(html).toContain('Aceptar cita');
    expect(html).toContain('Rechazar');
    expect(html).toContain('Paciente Ficticio');
    expect(html).toContain('Hora pedida');
    expect(html).toContain('Caduca');
  });

  it('un cambio enseña la cita actual y la hora nueva; una cancelación, la cita afectada', () => {
    const session = { id: 's1', startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:50:00.000Z', status: 'SCHEDULED' };
    const change = render(staffRequest({ type: 'RESCHEDULE', sessionId: 's1', session }));
    expect(change).toContain('Aceptar el cambio');
    expect(change).toContain('Cita actual');
    expect(change).toContain('Nueva hora pedida');
    const cancel = render(staffRequest({ type: 'CANCEL', sessionId: 's1', startsAt: null, endsAt: null, session }));
    expect(cancel).toContain('Aceptar la cancelación');
    expect(cancel).toContain('Cita que quiere cancelar');
    expect(cancel).not.toContain('Hora pedida');
  });

  it('las ya respondidas no tienen botones y el rechazo enseña su motivo', () => {
    const html = render(staffRequest({ status: 'REJECTED', rejectionReason: 'DISCUSS_IN_SESSION' }));
    expect(html).not.toContain('Aceptar');
    expect(html).not.toContain('Rechazar<');
    expect(html).toContain('Lo hablamos en sesión');
    expect(render(staffRequest({ status: 'EXPIRED' }))).toContain('Caducada');
  });

  it('quien ve a varios profesionales ve con cuál es; el terapeuta, no; y se avisa si pidió un tutor', () => {
    expect(render(staffRequest({}), true)).toContain('Con Ana García');
    expect(render(staffRequest({}), false)).not.toContain('Con Ana García');
    expect(render(staffRequest({ accessorType: 'GUARDIAN' }))).toContain('Pedida por su tutor/a');
  });

  it('no enseña motivo de consulta ni notas: la vista solo trae nombre, tipo y hueco', () => {
    const html = render(staffRequest({}));
    expect(html).not.toMatch(/motivo de consulta|objetivos|notas/i);
  });
});

describe('Disponibilidad', () => {
  it('el interruptor viene desactivado por defecto y se lee como interruptor', () => {
    const html = renderToStaticMarkup(<PortalBookingToggle canToggle isSelf enabled={false} hasWindows busy={false} onToggle={noop} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('Permitir que mis pacientes pidan cita desde su portal');
    expect(html).not.toContain('checked=""');
  });

  it('recepción no ve el interruptor, solo el estado', () => {
    const html = renderToStaticMarkup(<PortalBookingToggle canToggle={false} isSelf={false} enabled hasWindows busy={false} onToggle={noop} />);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('<input');
    expect(html).toContain('activada');
    expect(html).toContain('Solo el propio profesional');
  });

  it('titular o administración editando a otra persona lo ven con su nombre; sin franjas avisa', () => {
    const html = renderToStaticMarkup(<PortalBookingToggle canToggle isSelf={false} professionalName="Ana García" enabled hasWindows={false} busy={false} onToggle={noop} />);
    expect(html).toContain('Permitir que los pacientes de Ana García pidan cita desde su portal');
    expect(html).toContain('no verán horas libres');
  });

  it('las franjas muestran los siete días, "Sin consulta" en los vacíos y copiar solo donde hay franjas', () => {
    const html = renderToStaticMarkup(<WeeklyWindows windows={[{ weekday: 2, startMinute: 540, endMinute: 840 }, { weekday: 2, startMinute: 960, endMinute: 1200 }]} onChange={noop} />);
    for (const day of ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']) expect(html).toContain(day);
    expect(html.match(/Sin consulta/g)).toHaveLength(6);
    expect(html.match(/Copiar a otros días/g)).toHaveLength(1);
    expect(html).toContain('Martes, franja 2: desde');
    expect(html.match(/Añadir franja/g)).toHaveLength(7);
    expect(html).toContain('<option value="840" selected="">14:00</option>');
  });
});

describe('jest.fn sanity', () => {
  it('los callbacks no se llaman al pintar', () => {
    const onWithdraw = jest.fn();
    renderToStaticMarkup(<RequestsList requests={[portalRequest({})]} appointments={[]} busy={false} onWithdraw={onWithdraw} />);
    expect(onWithdraw).not.toHaveBeenCalled();
  });
});
