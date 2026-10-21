const createTransportMock = jest.fn();
jest.mock('nodemailer', () => ({ createTransport: (...args: unknown[]) => createTransportMock(...args) }));

import { ForbiddenException, Logger } from '@nestjs/common';
import { assertMailConfig, InvalidMailConfigError, readMailConfig } from '../src/mail/mail.config';
import { MailService, smtpTransport } from '../src/mail/mail.service';
import { WaitlistNotifier, WAITLIST_NOTIFY_RETRY_MS, WAITLIST_NOTIFY_SUBJECT, WAITLIST_NOTIFY_WINDOW_MS } from '../src/waitlist/waitlist-notifier';
import { WAITLIST_ACCEPTED, WaitlistService } from '../src/waitlist/waitlist.service';
import { issueFormToken } from '../src/waitlist/waitlist-crypto';

/**
 * Aviso por correo al Jefe de las altas en la lista de espera. Sin datos del apuntado, sin bloquear
 * el alta, agrupado, apagado por defecto y sin poder escribir a nadie que no sea interno.
 * Valores 100 % ficticios (ninguna credencial real).
 */

const SECRET = 'clave-ficticia-que-no-debe-salir-nunca';
const JEFE = 'jefe@example.test';
const configured = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MAIL_SMTP_HOST: 'smtp.example.test', MAIL_SMTP_PORT: '587', MAIL_SMTP_USER: 'proyecto-ficticio',
  MAIL_SMTP_PASSWORD: SECRET, MAIL_FROM: 'AsePsico <avisos@example.test>', WAITLIST_NOTIFY_TO: JEFE,
  WAITLIST_NOTIFY_ENABLED: 'true', ...extra,
});

const NAME = 'Profesional Ficticia Apuntada';
const EMAIL = 'apuntada.ficticia@example.test';
const TOOLS = 'Herramientas ficticias secretas';
const entry = () => ({
  name: NAME, email: EMAIL, situation: 'SELF_EMPLOYED', tools: TOOLS, source: 'INSTAGRAM', privacyAccepted: true,
  privacyPolicyVersion: 'lista-espera-v3', formToken: issueFormToken(Date.now() - 10_000),
}) as any;

function setup(env: NodeJS.ProcessEnv, sendImpl: () => Promise<void> = async () => undefined) {
  const send = jest.fn(sendImpl);
  const mail = new MailService(env, () => ({ send }));
  const prisma: any = {
    waitlistEntry: { create: jest.fn(async () => ({ id: 'w-1' })), count: jest.fn(async () => 7) },
  };
  const notifier = new WaitlistNotifier(prisma, mail, env);
  const waitlist = new WaitlistService(prisma, notifier);
  return { send, mail, prisma, notifier, waitlist };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  createTransportMock.mockReset();
});

describe('Configuración del correo', () => {
  it('sin configuración no se crea transporte y no se envía nada', async () => {
    const factory = jest.fn();
    const mail = new MailService({ WAITLIST_NOTIFY_TO: JEFE }, factory);
    expect(readMailConfig({})).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(mail.isConfigured()).toBe(false);
    await expect(mail.sendInternal({ to: JEFE, subject: WAITLIST_NOTIFY_SUBJECT, text: 'Texto ficticio de prueba' })).resolves.toBe(false);
  });

  it.each([
    ['MAIL_FROM con CRLF', { MAIL_FROM: 'AsePsico\r\nBcc: x@example.test <avisos@example.test>' }],
    ['MAIL_FROM con LF al final', { MAIL_FROM: 'AsePsico <avisos@example.test>\n' }],
    ['MAIL_FROM sin formato', { MAIL_FROM: 'no es un remitente' }],
    ['WAITLIST_NOTIFY_TO inválido', { WAITLIST_NOTIFY_TO: 'jefe@example.test, no-es-correo' }],
    ['WAITLIST_NOTIFY_TO vacío', { WAITLIST_NOTIFY_TO: '' }],
  ])('%s → readMailConfig null y no se crea transporte (sin depender de main.ts)', (_label, extra) => {
    const env = configured(extra as any);
    expect(readMailConfig(env)).toBeNull();
    const factory = jest.fn();
    expect(new MailService(env, factory).isConfigured()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    ['espacio final', 'AsePsico <avisos@example.test> '],
    ['salto de línea final', 'AsePsico <avisos@example.test>\n'],
    ['espacio inicial', ' AsePsico <avisos@example.test>'],
  ])('MAIL_FROM con %s → el arranque falla nombrando MAIL_FROM y no hay transporte (coherentes)', (_label, from) => {
    const env = configured({ MAIL_FROM: from });
    expect(() => assertMailConfig(env)).toThrow(/MAIL_FROM/);
    expect(readMailConfig(env)).toBeNull();
  });

  it('arranque y transporte siempre coinciden: si el arranque acepta, hay transporte', () => {
    const variants: Record<string, string>[] = [
      {}, { MAIL_SMTP_PORT: '465' }, { MAIL_FROM: 'avisos@example.test' }, { WAITLIST_NOTIFY_TO: `${JEFE}, otra@example.test` },
      { MAIL_SMTP_PORT: '2525' }, { MAIL_SMTP_HOST: '' }, { MAIL_FROM: 'Nombre\r\n <a@example.test>' }, { WAITLIST_NOTIFY_TO: 'mal' },
    ];
    for (const extra of variants) {
      const env = configured(extra);
      let startupOk = true;
      try { assertMailConfig(env); } catch { startupOk = false; }
      expect([JSON.stringify(extra), startupOk]).toEqual([JSON.stringify(extra), readMailConfig(env) !== null]);
    }
  });

  it('puerto distinto de 587/465 → sin transporte', () => {
    expect(readMailConfig(configured({ MAIL_SMTP_PORT: '25' }))).toBeNull();
  });

  it('ENABLED=false (o ausente) no exige nada; ENABLED=true sin config → error con NOMBRES, nunca valores', () => {
    expect(() => assertMailConfig({})).not.toThrow();
    expect(() => assertMailConfig({ WAITLIST_NOTIFY_ENABLED: 'false', MAIL_SMTP_PASSWORD: SECRET })).not.toThrow();
    let error: any;
    try { assertMailConfig({ WAITLIST_NOTIFY_ENABLED: 'true', MAIL_SMTP_PASSWORD: SECRET, MAIL_SMTP_PORT: '25', WAITLIST_NOTIFY_TO: 'no-es-un-correo' }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(InvalidMailConfigError);
    for (const name of ['MAIL_SMTP_HOST', 'MAIL_SMTP_USER', 'MAIL_FROM', 'MAIL_SMTP_PORT', 'WAITLIST_NOTIFY_TO']) expect(error.message).toContain(name);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('no-es-un-correo');
    expect(() => assertMailConfig(configured())).not.toThrow();
  });

  it('transporte SMTP: TLS obligatorio (STARTTLS exigido en 587, TLS implícito en 465), AUTH PLAIN, sin ficheros ni URLs', async () => {
    const sendMail = jest.fn(async () => ({}));
    createTransportMock.mockReturnValue({ sendMail });
    const config = readMailConfig(configured())!;
    await smtpTransport(config).send({ from: config.from, to: JEFE, subject: 'Asunto de prueba', text: 'Cuerpo de prueba' });
    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.test', port: 587, secure: false, requireTLS: true, authMethod: 'PLAIN',
      tls: expect.objectContaining({ minVersion: 'TLSv1.2', rejectUnauthorized: true }), disableFileAccess: true, disableUrlAccess: true,
    }));
    smtpTransport(readMailConfig(configured({ MAIL_SMTP_PORT: '465' }))!);
    expect(createTransportMock.mock.calls[1][0]).toMatchObject({ port: 465, secure: true, requireTLS: true });
  });
});

describe('MailService solo escribe a destinatarios internos', () => {
  it('cualquier destinatario fuera de WAITLIST_NOTIFY_TO → 403 sin tocar el transporte (p. ej. un paciente)', async () => {
    const send = jest.fn(async () => undefined);
    const mail = new MailService(configured(), () => ({ send }));
    await expect(mail.sendInternal({ to: 'paciente.ficticio@example.test', subject: WAITLIST_NOTIFY_SUBJECT, text: 'Texto ficticio de prueba' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(send).not.toHaveBeenCalled();
  });

  it('asunto o cuerpo de menos de 10 caracteres → error (requisito del proveedor)', async () => {
    const mail = new MailService(configured(), () => ({ send: jest.fn() }));
    await expect(mail.sendInternal({ to: JEFE, subject: 'Corto', text: 'Cuerpo suficientemente largo' })).rejects.toThrow();
  });
});

describe('Aviso de altas de la lista de espera', () => {
  it('ENABLED=false: el alta responde igual y no se envía nada', async () => {
    jest.useFakeTimers();
    const { send, waitlist } = setup(configured({ WAITLIST_NOTIFY_ENABLED: 'false' }));
    expect(await waitlist.submit(entry())).toEqual(WAITLIST_ACCEPTED);
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_WINDOW_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it('alta → un aviso al Jefe con asunto genérico y cuerpo sin datos del apuntado', async () => {
    jest.useFakeTimers();
    const { send, waitlist, prisma } = setup(configured());
    expect(await waitlist.submit(entry())).toEqual(WAITLIST_ACCEPTED);
    expect(send).not.toHaveBeenCalled(); // no bloquea la respuesta
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0] as any[];
    expect(message).toMatchObject({ to: JEFE, from: 'AsePsico <avisos@example.test>', subject: 'Nuevo apunte en la lista de espera' });
    expect(message.text).toContain('Hay 1 alta nueva');
    expect(message.text).toContain('Total activas: 7');
    expect(message.text).toContain('waitlist:export');
    expect(message.subject.length).toBeGreaterThanOrEqual(10);
    expect(message.text.length).toBeGreaterThanOrEqual(10);
    for (const secret of [NAME, EMAIL, EMAIL.split('@')[0], TOOLS, 'SELF_EMPLOYED', 'INSTAGRAM']) {
      expect(JSON.stringify(message)).not.toContain(secret);
    }
    expect(message.html).toBeUndefined();
    expect(prisma.waitlistEntry.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });

  it('alta repetida (P2002) u honeypot: no avisan', async () => {
    jest.useFakeTimers();
    const { send, waitlist, prisma } = setup(configured());
    const { Prisma } = await import('@prisma/client');
    prisma.waitlistEntry.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await waitlist.submit(entry());
    await waitlist.submit({ ...entry(), website: 'relleno' });
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_WINDOW_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it('fallo SMTP: el alta responde igual, 1 solo reintento y el aviso de log no lleva destinatario ni contenido', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error(`conexión rechazada para ${JEFE} con ${SECRET}`), { name: 'SmtpError', code: 'ECONNECTION' });
    const { send, waitlist } = setup(configured(), async () => { throw failure; });
    expect(await waitlist.submit(entry())).toEqual(WAITLIST_ACCEPTED);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_RETRY_MS);
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_RETRY_MS * 10);
    expect(send).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('SmtpError');
    expect(logged).toContain('ECONNECTION');
    for (const secret of [JEFE, SECRET, 'conexión rechazada', 'Hay 1 alta', NAME, EMAIL]) expect(logged).not.toContain(secret);
  });

  it('fallo de la base de datos al contar: tampoco afecta al alta', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { send, waitlist, prisma } = setup(configured());
    prisma.waitlistEntry.count.mockRejectedValue(Object.assign(new Error('db'), { name: 'PrismaClientKnownRequestError' }));
    expect(await waitlist.submit(entry())).toEqual(WAITLIST_ACCEPTED);
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_RETRY_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });

  it('agrupa: como mucho 1 aviso cada 10 min con el recuento acumulado', async () => {
    jest.useFakeTimers();
    const { send, notifier } = setup(configured());
    notifier.notifyNewEntry();
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) notifier.notifyNewEntry();
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_WINDOW_MS - 1000);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1] as any[])[0].text).toContain('Hay 5 altas nuevas');

    // Pasada la ventana sin altas, la siguiente sale enseguida.
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_WINDOW_MS);
    notifier.notifyNewEntry();
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3);
    notifier.onModuleDestroy();
  });

  it('el reintento va SOLO a los destinatarios que fallaron; las altas de mientras tanto, al siguiente aviso', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const OTRO = 'socia@example.test';
    let failOtro = true;
    const { send, notifier } = setup(configured({ WAITLIST_NOTIFY_TO: `${JEFE}, ${OTRO}` }), async () => undefined);
    send.mockImplementation((async (message: any) => {
      if (message.to === OTRO && failOtro) { failOtro = false; throw Object.assign(new Error('fallo'), { name: 'SmtpError' }); }
    }) as any);
    notifier.notifyNewEntry();
    await jest.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.map((c: any) => c[0].to)).toEqual([JEFE, OTRO]);

    notifier.notifyNewEntry();
    notifier.notifyNewEntry();
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_RETRY_MS);
    expect(send.mock.calls.map((c: any) => c[0].to)).toEqual([JEFE, OTRO, OTRO]);
    expect((send.mock.calls[2] as any[])[0].text).toContain('Hay 1 alta nueva');

    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_WINDOW_MS);
    expect(send.mock.calls.slice(3).map((c: any) => [c[0].to, c[0].text.includes('Hay 2 altas nuevas')])).toEqual([[JEFE, true], [OTRO, true]]);
    expect(notifier.pendingCount()).toBe(0);
  });

  it('ráfaga de 1000 altas en la misma ventana → 1 envío por destinatario y nada pendiente', async () => {
    jest.useFakeTimers();
    const OTRO = 'socia@example.test';
    const { send, notifier, waitlist } = setup(configured({ WAITLIST_NOTIFY_TO: `${JEFE},${OTRO}` }));
    for (let i = 0; i < 1000; i++) await waitlist.submit(entry());
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c: any) => c[0].to).sort()).toEqual([JEFE, OTRO].sort());
    expect((send.mock.calls[0] as any[])[0].text).toContain('Hay 1000 altas nuevas');
    expect(notifier.pendingCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(WAITLIST_NOTIFY_WINDOW_MS * 3);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['tarda 30 s', () => new Promise<void>((resolve) => setTimeout(resolve, 30_000))],
    ['lanza', async () => { throw new Error('caído'); }],
  ])('el alta no depende del transporte (%s): resuelve sin avanzar los temporizadores', async (_label, impl) => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { send, waitlist } = setup(configured(), impl as any);
    await expect(waitlist.submit(entry())).resolves.toEqual(WAITLIST_ACCEPTED);
    expect(send).not.toHaveBeenCalled();
  });
});
});
