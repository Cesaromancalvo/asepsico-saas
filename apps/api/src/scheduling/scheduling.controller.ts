import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PortalGuard } from '../portal/portal.guard';
import { AppointmentRequestsService } from './appointment-requests.service';
import { AvailabilityService } from './availability.service';
import {
  CreateAvailabilityBlockDto,
  ListAppointmentRequestsQueryDto,
  PortalCancelRequestDto,
  PortalCreateRequestDto,
  PortalRescheduleRequestDto,
  PortalSlotsQueryDto,
  RejectAppointmentRequestDto,
  SetPortalBookingDto,
  SetTimeZoneDto,
  UpdateAvailabilityDto,
} from './dto/scheduling.dto';
import { PortalBookingService } from './portal-booking.service';
import { PortalRateLimit, PortalRateLimitGuard } from './portal-rate-limit.guard';

/** Agenda del profesional: disponibilidad, bloqueos, zona horaria y bandeja de solicitudes. */
@ApiTags('scheduling')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('scheduling')
export class SchedulingController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly requests: AppointmentRequestsService,
  ) {}

  @Get('time-zone')
  getTimeZone(@CurrentUser() user: AuthUser) { return this.availability.getTimeZone(user); }

  @Patch('time-zone')
  setTimeZone(@CurrentUser() user: AuthUser, @Body() dto: SetTimeZoneDto) { return this.availability.setTimeZone(user, dto); }

  @Get('professionals')
  listProfessionals(@CurrentUser() user: AuthUser) { return this.availability.listProfessionals(user); }

  @Get('availability/:therapistId')
  getAvailability(@CurrentUser() user: AuthUser, @Param('therapistId') therapistId: string) { return this.availability.get(user, therapistId); }

  @Put('availability/:therapistId')
  updateAvailability(@CurrentUser() user: AuthUser, @Param('therapistId') therapistId: string, @Body() dto: UpdateAvailabilityDto) {
    return this.availability.update(user, therapistId, dto);
  }

  @Patch('availability/:therapistId/portal-booking')
  setPortalBooking(@CurrentUser() user: AuthUser, @Param('therapistId') therapistId: string, @Body() dto: SetPortalBookingDto) {
    return this.availability.setPortalBooking(user, therapistId, dto);
  }

  @Post('availability/:therapistId/blocks')
  createBlock(@CurrentUser() user: AuthUser, @Param('therapistId') therapistId: string, @Body() dto: CreateAvailabilityBlockDto) {
    return this.availability.createBlock(user, therapistId, dto);
  }

  @Delete('availability/:therapistId/blocks/:blockId')
  deleteBlock(@CurrentUser() user: AuthUser, @Param('therapistId') therapistId: string, @Param('blockId') blockId: string) {
    return this.availability.deleteBlock(user, therapistId, blockId);
  }

  @Get('requests')
  listRequests(@CurrentUser() user: AuthUser, @Query() query: ListAppointmentRequestsQueryDto) { return this.requests.list(user, query); }

  @Get('requests/pending-count')
  pendingCount(@CurrentUser() user: AuthUser) { return this.requests.pendingCount(user); }

  @Post('requests/:id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.requests.approve(user, id); }

  @Post('requests/:id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectAppointmentRequestDto) { return this.requests.reject(user, id, dto); }
}

const SLOTS_PER_MINUTE = { bucket: 'slots', limit: 30, windowMs: 60_000 };
const WRITES_PER_HOUR = { bucket: 'booking-write', limit: 10, windowMs: 3_600_000 };

/**
 * Reserva desde el portal. Límites: por cuenta (PortalRateLimitGuard, y 5 solicitudes/hora en BD)
 * y por IP (@Throttle sobre el ThrottlerGuard global).
 */
@ApiTags('portal-booking')
@Controller('portal/booking')
export class PortalBookingController {
  constructor(private readonly booking: PortalBookingService) {}

  @Get('options') @UseGuards(PortalGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  options(@Req() req: any) { return this.booking.options(req.portalUser); }

  @Get('slots') @UseGuards(PortalGuard, PortalRateLimitGuard)
  @PortalRateLimit(SLOTS_PER_MINUTE)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  slots(@Req() req: any, @Query() query: PortalSlotsQueryDto) { return this.booking.slots(req.portalUser, query); }

  @Get('requests') @UseGuards(PortalGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  listRequests(@Req() req: any) { return this.booking.listRequests(req.portalUser); }

  @Post('requests') @UseGuards(PortalGuard, CsrfGuard, PortalRateLimitGuard)
  @PortalRateLimit(WRITES_PER_HOUR)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  create(@Req() req: any, @Body() dto: PortalCreateRequestDto) { return this.booking.createRequest(req.portalUser, dto); }

  @Post('requests/reschedule') @UseGuards(PortalGuard, CsrfGuard, PortalRateLimitGuard)
  @PortalRateLimit(WRITES_PER_HOUR)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  reschedule(@Req() req: any, @Body() dto: PortalRescheduleRequestDto) { return this.booking.rescheduleRequest(req.portalUser, dto); }

  @Post('requests/cancel') @UseGuards(PortalGuard, CsrfGuard, PortalRateLimitGuard)
  @PortalRateLimit(WRITES_PER_HOUR)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  cancel(@Req() req: any, @Body() dto: PortalCancelRequestDto) { return this.booking.cancelRequest(req.portalUser, dto); }

  @Post('requests/:id/withdraw') @UseGuards(PortalGuard, CsrfGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  withdraw(@Req() req: any, @Param('id') id: string) { return this.booking.withdraw(req.portalUser, id); }
}
