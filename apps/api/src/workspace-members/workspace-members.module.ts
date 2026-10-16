import { Module } from '@nestjs/common';
import { WorkspaceMembersController } from './workspace-members.controller';
import { WorkspaceMembersService } from './workspace-members.service';
import { WorkspaceInvitesService } from './workspace-invites.service';

@Module({ controllers: [WorkspaceMembersController], providers: [WorkspaceMembersService, WorkspaceInvitesService] })
export class WorkspaceMembersModule {}
