import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { randomBytes } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { ChangePortalPasswordDto, EnablePortalDto, PortalLoginDto } from './dto/portal.dto';
import { SaveTaskProgressDto } from './dto/task-response.dto';
import { PortalGuard } from './portal.guard';
import { PortalService } from './portal.service';

@Controller()
export class PortalController {
  constructor(private readonly service:PortalService) {}

  @Post('portal/auth/login')
  async login(@Body() dto:PortalLoginDto, @Res({passthrough:true}) res:Response) {
    const result = await this.service.login(dto);
    res.cookie('portal_access_token', result.accessToken, { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'lax', path:'/api/v1/portal', maxAge:30*60*1000 });
    res.cookie('csrf_token', randomBytes(32).toString('base64url'), { httpOnly:false, secure:process.env.NODE_ENV==='production', sameSite:'lax', path:'/', maxAge:30*60*1000 });
    return { patient:result.patient, mustChangePassword:result.mustChangePassword };
  }

  @Post('portal/auth/logout') @UseGuards(CsrfGuard)
  logout(@Res({passthrough:true}) res:Response) { res.clearCookie('portal_access_token',{path:'/api/v1/portal'}); res.clearCookie('csrf_token',{path:'/'}); return {ok:true}; }

  @Get('portal/dashboard') @UseGuards(PortalGuard)
  dashboard(@Req() req:any) { return this.service.dashboard(req.portalUser); }

  @Patch('portal/tasks/:taskId/progress') @UseGuards(PortalGuard, CsrfGuard)
  saveTaskProgress(@Req() req:any,@Param('taskId') taskId:string,@Body() dto:SaveTaskProgressDto){return this.service.saveTaskProgress(req.portalUser,taskId,dto);}

  @Post('portal/tasks/:taskId/submit') @UseGuards(PortalGuard, CsrfGuard)
  submitTask(@Req() req:any,@Param('taskId') taskId:string){return this.service.submitTask(req.portalUser,taskId);}

  @Patch('portal/password') @UseGuards(PortalGuard, CsrfGuard)
  changePassword(@Req() req:any, @Body() dto:ChangePortalPasswordDto) { return this.service.changePassword(req.portalUser,dto); }

  @Post('patients/:patientId/portal-account') @UseGuards(JwtAuthGuard, CsrfGuard)
  enable(@Req() req:any,@Param('patientId') patientId:string,@Body() dto:EnablePortalDto){ return this.service.enable(req.user.workspaceId,req.user,patientId,dto); }

  @Delete('patients/:patientId/portal-account') @UseGuards(JwtAuthGuard, CsrfGuard)
  disable(@Req() req:any,@Param('patientId') patientId:string){ return this.service.disable(req.user.workspaceId,req.user,patientId); }
}
