import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { PortalGuard } from '../portal/portal.guard';
import { UpdateNotificationPreferencesDto, UpdateStaffEmailPreferencesDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

@Controller()
export class NotificationsController {
  constructor(private readonly service:NotificationsService) {}

  @Get('notifications') @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user:AuthUser, @Query('unreadOnly') unreadOnly?:string) { return this.service.listProfessional(user, unreadOnly==='true'); }
  @Get('notifications/unread-count') @UseGuards(JwtAuthGuard)
  unreadCount(@CurrentUser() user:AuthUser) { return this.service.unreadCountProfessional(user); }
  @Post('notifications/read-all') @UseGuards(JwtAuthGuard, CsrfGuard)
  markAllRead(@CurrentUser() user:AuthUser) { return this.service.markAllProfessionalRead(user); }
  @Get('notifications/preferences') @UseGuards(JwtAuthGuard)
  preferences(@CurrentUser() user:AuthUser) { return this.service.getProfessionalPreferences(user); }
  @Patch('notifications/preferences') @UseGuards(JwtAuthGuard, CsrfGuard)
  updatePreferences(@CurrentUser() user:AuthUser,@Body() dto:UpdateNotificationPreferencesDto) { return this.service.updateProfessionalPreferences(user,dto); }
  // N4 · Avisos por email del propio usuario en su espacio actual. Cualquier rol de staff; nunca de otro usuario.
  @Get('notifications/email-preferences') @UseGuards(JwtAuthGuard)
  emailPreferences(@CurrentUser() user:AuthUser) { return this.service.getStaffEmailPreferences(user); }
  @Patch('notifications/email-preferences') @UseGuards(JwtAuthGuard, CsrfGuard)
  updateEmailPreferences(@CurrentUser() user:AuthUser,@Body() dto:UpdateStaffEmailPreferencesDto) { return this.service.updateStaffEmailPreferences(user,dto); }
  @Patch('notifications/:id/read') @UseGuards(JwtAuthGuard, CsrfGuard)
  markRead(@CurrentUser() user:AuthUser,@Param('id') id:string) { return this.service.markProfessionalRead(user,id); }
  @Post('notifications/process-due') @UseGuards(JwtAuthGuard, CsrfGuard)
  process(@CurrentUser() user:AuthUser) { return this.service.processDue(user); }

  @Get('portal/notifications') @UseGuards(PortalGuard)
  portalList(@Req() req:any) { return this.service.listPatient(req.portalUser); }
  @Get('portal/notifications/preferences') @UseGuards(PortalGuard)
  portalPreferences(@Req() req:any) { return this.service.getPatientPreferences(req.portalUser); }
  @Patch('portal/notifications/preferences') @UseGuards(PortalGuard, CsrfGuard)
  portalUpdatePreferences(@Req() req:any,@Body() dto:UpdateNotificationPreferencesDto) { return this.service.updatePatientPreferences(req.portalUser,dto); }
  @Patch('portal/notifications/:id/read') @UseGuards(PortalGuard, CsrfGuard)
  portalMarkRead(@Req() req:any,@Param('id') id:string) { return this.service.markPatientRead(req.portalUser,id); }
}
