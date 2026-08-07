import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { BillingService } from './billing.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto, VoidInvoiceDto } from './dto/update-invoice.dto';
import { CreatePaymentDto, ReversePaymentDto } from './dto/create-payment.dto';

@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('billing')
export class BillingController {
  constructor(private billing: BillingService) {}

  @Get('summary') summary(@CurrentUser() user: AuthUser) {
    return this.billing.summary(user.workspaceId, user);
  }

  @Get('invoices') list(@CurrentUser() user: AuthUser, @Query('patientId') patientId?: string) {
    return this.billing.list(user.workspaceId, user, patientId);
  }

  @Get('invoices/:id') get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.get(user.workspaceId, user, id);
  }

  @Post('invoices') create(@CurrentUser() user: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.billing.create(user.workspaceId, user, dto);
  }

  @Patch('invoices/:id') update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.billing.update(user.workspaceId, user, id, dto);
  }

  @Post('invoices/:id/issue') issue(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.issue(user.workspaceId, user, id);
  }

  @Post('invoices/:id/void') voidInvoice(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: VoidInvoiceDto) {
    return this.billing.void(user.workspaceId, user, id, dto.reason);
  }

  @Post('invoices/:id/send') sendToPatient(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.sendToPatient(user.workspaceId, user, id);
  }

  @Post('payments') recordPayment(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto) {
    return this.billing.recordPayment(user.workspaceId, user, dto);
  }

  @Post('payments/:id/reverse') reversePayment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReversePaymentDto) {
    return this.billing.reversePayment(user.workspaceId, user, id, dto.reason);
  }
}
