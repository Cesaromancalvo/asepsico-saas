import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
} from '@nestjs/swagger';

import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { CloseSessionDto } from './dto/close-session.dto';
import { CreateSessionDto } from './dto/create-session.dto';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { RescheduleSessionDto } from './dto/reschedule-session.dto';
import { UpdateSessionNotesDto } from './dto/update-session-notes.dto';
import { SessionsService } from './sessions.service';

@ApiTags('sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CsrfGuard)
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSessionsQueryDto,
  ) {
    return this.sessions.list(
      user.workspaceId,
      user,
      query,
    );
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.sessions.get(
      user.workspaceId,
      user,
      id,
    );
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessions.create(
      user.workspaceId,
      user,
      dto,
    );
  }

  @Patch(':id')
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RescheduleSessionDto,
  ) {
    return this.sessions.reschedule(
      user.workspaceId,
      user,
      id,
      dto,
    );
  }

  @Patch(':id/notes')
  updateNotes(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateSessionNotesDto,
  ) {
    return this.sessions.updateNotes(
      user.workspaceId,
      user,
      id,
      dto,
    );
  }

  @Patch(':id/close')
  close(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CloseSessionDto,
  ) {
    return this.sessions.close(
      user.workspaceId,
      user,
      id,
      dto.status,
    );
  }
}