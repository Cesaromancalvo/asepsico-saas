import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { CreateInvoiceDto, CreateInvoiceLineDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { invoiceForRole, paymentForRole, summaryConcept } from './invoice-concepts';

/**
 * Listado de facturas: resumen SIN líneas ni notas (texto libre). Recepción (ASSISTANT) usa
 * facturación y no debe recibir nada que pueda ser clínico (condición de Argos).
 */
const INVOICE_LIST_SELECT = {
  id: true, patientId: true, invoiceNumber: true, status: true, currency: true, issueDate: true, dueDate: true,
  subtotalCents: true, taxCents: true, totalCents: true, paidCents: true, createdAt: true, updatedAt: true,
  patient: { select: { id: true, firstName: true, lastName: true } },
  payments: { where: { reversedAt: null }, orderBy: { paidAt: 'desc' as const }, select: { id: true, amountCents: true, method: true, paidAt: true } },
  // Solo para calcular `concept`; no se devuelve.
  lines: { select: { description: true }, orderBy: { createdAt: 'asc' as const }, take: 1 },
} as const;

const INVOICE_DETAIL_INCLUDE = {
  patient: { select: { id: true, firstName: true, lastName: true, email: true } },
  lines: true,
  payments: { orderBy: { paidAt: 'desc' as const } },
} as const;

@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService) {}

  private assertBillingRole(actor: AuthUser) {
    if (!['OWNER', 'ADMIN', 'ASSISTANT'].includes(actor.role)) {
      throw new ForbiddenException('No tienes permisos para acceder a facturación');
    }
  }

  // Límite de seguridad independiente de los del DTO: aunque cambien los máximos ahí, o
  // Update reutilice tipos distintos, esto evita que un total calculado se acerque al
  // límite del tipo Int de PostgreSQL (~2.147 millones) y reviente al guardar.
  private static readonly MAX_SAFE_TOTAL_CENTS = 500_000_000; // 5 millones de euros

  private calculate(lines: CreateInvoiceLineDto[]) {
    const calculated = lines.map((line) => {
      const lineSubtotalCents = line.quantity * line.unitPriceCents;
      const taxRateBps = line.taxRateBps ?? 0;
      const lineTaxCents = Math.round((lineSubtotalCents * taxRateBps) / 10_000);
      return { ...line, taxRateBps, lineSubtotalCents, lineTaxCents, lineTotalCents: lineSubtotalCents + lineTaxCents };
    });
    const totalCents = calculated.reduce((sum, line) => sum + line.lineTotalCents, 0);
    if (totalCents > BillingService.MAX_SAFE_TOTAL_CENTS) {
      throw new BadRequestException('El importe total de la factura supera el máximo permitido');
    }
    return {
      lines: calculated,
      subtotalCents: calculated.reduce((sum, line) => sum + line.lineSubtotalCents, 0),
      taxCents: calculated.reduce((sum, line) => sum + line.lineTaxCents, 0),
      totalCents,
    };
  }

  async list(workspaceId: string, actor: AuthUser, patientId?: string) {
    this.assertBillingRole(actor);
    const invoices = await (this.prisma as any).invoice.findMany({
      where: { workspaceId, ...(patientId ? { patientId } : {}) },
      select: INVOICE_LIST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return invoices.map(({ lines, ...invoice }: any) => ({ ...invoice, concept: summaryConcept(lines) }));
  }

  async get(workspaceId: string, actor: AuthUser, id: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({
      where: { id, workspaceId }, include: INVOICE_DETAIL_INCLUDE,
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    return this.forRole(invoice, actor);
  }

  /** Detalle: los textos libres (líneas antiguas, notas, motivo de anulación, notas y referencia de pagos) solo para OWNER/ADMIN. */
  private forRole<T extends Record<string, any>>(invoice: T, actor: AuthUser): T {
    return invoiceForRole(invoice, actor.role);
  }

  /** Detalle completo de una factura, siempre acotado al workspace. */
  private loadInvoice(db: any, workspaceId: string, id: string) {
    return db.invoice.findFirst({ where: { id, workspaceId }, include: INVOICE_DETAIL_INCLUDE });
  }

  /** Escritura acotada al workspace (nunca solo por id) con compare-and-set; 0 filas → 400. */
  private async scopedInvoiceUpdate(tx: any, where: Record<string, unknown> & { id: string; workspaceId: string }, data: Record<string, unknown>) {
    const { count } = await tx.invoice.updateMany({ where, data });
    if (count !== 1) throw new BadRequestException('La factura cambió mientras se guardaba; vuelve a intentarlo');
  }

  async create(workspaceId: string, actor: AuthUser, dto: CreateInvoiceDto) {
    this.assertBillingRole(actor);
    const patient = await (this.prisma as any).patient.findFirst({ where: { id: dto.patientId, workspaceId, deletedAt: null } });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
    const amounts = this.calculate(dto.lines);
    if (amounts.totalCents <= 0) throw new BadRequestException('El total debe ser mayor que cero');

    return (this.prisma as any).$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', workspaceId);
      const latest = await tx.invoice.findFirst({ where: { workspaceId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      const sequence = (latest?.sequence ?? 0) + 1;
      // Referencia interna del cobro: AsePsico no emite facturas, así que el prefijo no puede
      // parecer un número de factura (A2 pre-piloto). Los cobros antiguos conservan su «FAC-».
      const invoiceNumber = `COB-${new Date().getFullYear()}-${String(sequence).padStart(4, '0')}`;
      const invoice = await tx.invoice.create({
        data: {
          workspaceId, patientId: dto.patientId, sequence, invoiceNumber, currency: (dto.currency ?? 'EUR').toUpperCase(),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null, notes: dto.notes,
          subtotalCents: amounts.subtotalCents, taxCents: amounts.taxCents, totalCents: amounts.totalCents,
          createdById: actor.sub, lines: { create: amounts.lines },
        }, include: INVOICE_DETAIL_INCLUDE,
      });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_CREATED', entityType: 'Invoice', entityId: invoice.id, metadata: { invoiceNumber, totalCents: amounts.totalCents } } });
      return this.forRole(invoice, actor);
    });
  }

  async update(workspaceId: string, actor: AuthUser, id: string, dto: UpdateInvoiceDto) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id, workspaceId }, include: { payments: { where: { reversedAt: null } } } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status !== 'DRAFT') throw new BadRequestException('Solo se pueden editar facturas en borrador');
    const amounts = dto.lines ? this.calculate(dto.lines) : null;
    return (this.prisma as any).$transaction(async (tx: any) => {
      await this.scopedInvoiceUpdate(tx, { id, workspaceId, status: 'DRAFT' }, {
        dueDate: dto.dueDate ? new Date(dto.dueDate) : dto.dueDate === undefined ? undefined : null,
        notes: dto.notes,
        ...(amounts ? { subtotalCents: amounts.subtotalCents, taxCents: amounts.taxCents, totalCents: amounts.totalCents } : {}),
      });
      if (amounts) {
        // Solo tras confirmar (arriba) que la factura es de este workspace y sigue en borrador.
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id, invoice: { workspaceId } } });
        await tx.invoiceLine.createMany({ data: amounts.lines.map((line) => ({ ...line, invoiceId: id })) });
      }
      const updated = await this.loadInvoice(tx, workspaceId, id);
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_UPDATED', entityType: 'Invoice', entityId: id } });
      return this.forRole(updated, actor);
    });
  }

  async issue(workspaceId: string, actor: AuthUser, id: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id, workspaceId } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status !== 'DRAFT') throw new BadRequestException('La factura no está en borrador');
    return (this.prisma as any).$transaction(async (tx: any) => {
      await this.scopedInvoiceUpdate(tx, { id, workspaceId, status: 'DRAFT' }, { status: 'ISSUED', issueDate: new Date() });
      const updated = await this.loadInvoice(tx, workspaceId, id);
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: id } });
      return this.forRole(updated, actor);
    });
  }

  async void(workspaceId: string, actor: AuthUser, id: string, reason: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id, workspaceId }, include: { payments: { where: { reversedAt: null } } } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status === 'PAID' || invoice.payments.length) throw new BadRequestException('No se puede anular una factura con pagos activos');
    if (invoice.status === 'VOID') throw new BadRequestException('La factura ya está anulada');
    return (this.prisma as any).$transaction(async (tx: any) => {
      await this.scopedInvoiceUpdate(tx, { id, workspaceId, status: { notIn: ['VOID', 'PAID'] } as any }, { status: 'VOID', voidReason: reason });
      const updated = await this.loadInvoice(tx, workspaceId, id);
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'INVOICE_VOIDED', entityType: 'Invoice', entityId: id, metadata: { invoiceId: id, reasonProvided: true } } });
      return this.forRole(updated, actor);
    });
  }

  async recordPayment(workspaceId: string, actor: AuthUser, dto: CreatePaymentDto) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({ where: { id: dto.invoiceId, workspaceId }, include: { payments: { where: { reversedAt: null } } } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (!['ISSUED','PARTIALLY_PAID','OVERDUE'].includes(invoice.status)) throw new BadRequestException('La factura no admite pagos');
    const activePaid = invoice.payments.reduce((sum: number, payment: any) => sum + payment.amountCents, 0);
    if (dto.amountCents > invoice.totalCents - activePaid) throw new BadRequestException('El pago supera el saldo pendiente');

    if (dto.idempotencyKey) {
      const existing = await (this.prisma as any).payment.findFirst({ where: { workspaceId, idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        const sameOperation = existing.invoiceId === dto.invoiceId
          && existing.amountCents === dto.amountCents
          && existing.method === dto.method;
        if (!sameOperation) {
          throw new BadRequestException('La clave de idempotencia ya se utilizó para otra operación');
        }
        return paymentForRole(existing, actor.role);
      }
    }

    return (this.prisma as any).$transaction(async (tx: any) => {
      const payment = await tx.payment.create({ data: {
        workspaceId, patientId: invoice.patientId, invoiceId: invoice.id, amountCents: dto.amountCents,
        method: dto.method, paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(), reference: dto.reference,
        idempotencyKey: dto.idempotencyKey, notes: dto.notes, recordedById: actor.sub,
      }});
      const paidCents = activePaid + dto.amountCents;
      await this.scopedInvoiceUpdate(tx, { id: invoice.id, workspaceId }, { paidCents, status: paidCents === invoice.totalCents ? 'PAID' : 'PARTIALLY_PAID' });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PAYMENT_RECORDED', entityType: 'Payment', entityId: payment.id, metadata: { invoiceId: invoice.id, amountCents: dto.amountCents, method: dto.method } } });
      return paymentForRole(payment, actor.role);
    });
  }

  async reversePayment(workspaceId: string, actor: AuthUser, paymentId: string, reason: string) {
    this.assertBillingRole(actor);
    const payment = await (this.prisma as any).payment.findFirst({ where: { id: paymentId, workspaceId }, include: { invoice: true } });
    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (payment.reversedAt) throw new BadRequestException('El pago ya está revertido');
    return (this.prisma as any).$transaction(async (tx: any) => {
      const reversed = await tx.payment.updateMany({ where: { id: paymentId, workspaceId, reversedAt: null }, data: { reversedAt: new Date(), reversalReason: reason } });
      if (reversed.count !== 1) throw new BadRequestException('El pago ya está revertido');
      const updatedPayment = await tx.payment.findFirst({ where: { id: paymentId, workspaceId } });
      const aggregate = await tx.payment.aggregate({ where: { workspaceId, invoiceId: payment.invoiceId, reversedAt: null, id: { not: paymentId } }, _sum: { amountCents: true } });
      const paidCents = aggregate._sum.amountCents ?? 0;
      await this.scopedInvoiceUpdate(tx, { id: payment.invoiceId, workspaceId }, { paidCents, status: paidCents === 0 ? 'ISSUED' : paidCents >= payment.invoice.totalCents ? 'PAID' : 'PARTIALLY_PAID' });
      await tx.auditLog.create({ data: { workspaceId, actorId: actor.sub, action: 'PAYMENT_REVERSED', entityType: 'Payment', entityId: paymentId, metadata: { invoiceId: payment.invoiceId, reasonProvided: true } } });
      return paymentForRole(updatedPayment, actor.role);
    });
  }

  async sendToPatient(workspaceId: string, actor: AuthUser, id: string) {
    this.assertBillingRole(actor);
    const invoice = await (this.prisma as any).invoice.findFirst({
      where: { id, workspaceId },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            // portalAccount (singular) → portalAccounts (plural): ahora un paciente puede
            // tener varias cuentas de portal (la suya propia y la de sus tutores). Para
            // avisar de una factura, basta con que exista al menos una cuenta activa,
            // sea del paciente o de un tutor.
            portalAccounts: { where: { isActive: true }, select: { id: true, email: true, accessorType: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status === 'DRAFT') throw new BadRequestException('Emite la factura antes de enviarla');
    if (invoice.status === 'VOID') throw new BadRequestException('No se puede enviar una factura anulada');

    const activePortalAccounts = invoice.patient.portalAccounts ?? [];
    const hasPortal = activePortalAccounts.length > 0;
    const email = activePortalAccounts[0]?.email || invoice.patient.email;
    if (!hasPortal && !email) {
      throw new BadRequestException('El paciente necesita un portal activo o un correo electrónico para recibir la factura');
    }

    const preferences = await (this.prisma as any).notificationPreference.findUnique({
      where: { patientId: invoice.patientId },
    });
    const channels = ['IN_APP'];
    if (email && preferences?.emailEnabled) channels.push('EMAIL');

    return (this.prisma as any).$transaction(async (tx: any) => {
      const notification = await tx.notification.upsert({
        where: { dedupeKey: `invoice:${invoice.id}:shared` },
        create: {
          workspaceId,
          audience: 'PATIENT',
          patientId: invoice.patientId,
          type: 'INVOICE_DUE',
          title: `Cobro ${invoice.invoiceNumber}`,
          body: `Tienes disponible un cobro por ${(invoice.totalCents / 100).toFixed(2)} EUR.`,
          actionUrl: '/portal',
          status: 'SENT',
          scheduledAt: new Date(),
          sentAt: new Date(),
          dedupeKey: `invoice:${invoice.id}:shared`,
          metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
        },
        update: {
          status: 'SENT',
          readAt: null,
          sentAt: new Date(),
          body: `Tienes disponible un cobro por ${(invoice.totalCents / 100).toFixed(2)} EUR.`,
        },
      });

      for (const channel of channels) {
        await tx.notificationDelivery.upsert({
          where: { notificationId_channel: { notificationId: notification.id, channel } },
          create: {
            notificationId: notification.id,
            channel,
            status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
            attemptedAt: channel === 'IN_APP' ? new Date() : null,
          },
          update: {
            status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
            attemptedAt: channel === 'IN_APP' ? new Date() : null,
            errorCode: null,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorId: actor.sub,
          action: 'INVOICE_SENT_TO_PATIENT',
          entityType: 'Invoice',
          entityId: invoice.id,
          metadata: { patientId: invoice.patientId, channels },
        },
      });
      return { ok: true, invoiceId: invoice.id, channels, recipient: email ?? 'portal' };
    });
  }

  async summary(workspaceId: string, actor: AuthUser) {
    this.assertBillingRole(actor);
    const invoices = await (this.prisma as any).invoice.findMany({ where: { workspaceId, status: { not: 'VOID' } }, select: { totalCents: true, paidCents: true, status: true, dueDate: true } });
    const now = new Date();
    return {
      invoicedCents: invoices.reduce((s: number, i: any) => s + i.totalCents, 0),
      collectedCents: invoices.reduce((s: number, i: any) => s + i.paidCents, 0),
      outstandingCents: invoices.reduce((s: number, i: any) => s + Math.max(0, i.totalCents - i.paidCents), 0),
      overdueCount: invoices.filter((i: any) => i.dueDate && i.dueDate < now && !['PAID','VOID'].includes(i.status)).length,
    };
  }
}
