import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PortalGuard } from '../portal/portal.guard';
import { SendMessageDto, UpdateConversationDto } from './dto/message.dto';
import { MessagesService } from './messages.service';

@ApiTags('messages')
@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Get('messages')
  list(@CurrentUser() user: AuthUser, @Query('q') q?: string) { return this.messages.list(user.workspaceId, user, q); }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('patients/:patientId/conversation')
  getOrCreate(@CurrentUser() user: AuthUser, @Param('patientId') patientId: string) { return this.messages.getOrCreate(user.workspaceId, user, patientId); }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Get('messages/:id')
  thread(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.messages.thread(user.workspaceId, user, id); }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Post('messages/:id')
  send(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SendMessageDto) { return this.messages.send(user.workspaceId, user, id, dto); }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, CsrfGuard)
  @Patch('messages/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateConversationDto) { return this.messages.update(user.workspaceId, user, id, dto); }

  @UseGuards(PortalGuard)
  @Get('portal/messages')
  portalThread(@Req() req: any) { return this.messages.portalThread(req.portalUser); }

  @UseGuards(PortalGuard, CsrfGuard)
  @Post('portal/messages')
  portalSend(@Req() req: any, @Body() dto: SendMessageDto) { return this.messages.portalSend(req.portalUser, dto); }
}
