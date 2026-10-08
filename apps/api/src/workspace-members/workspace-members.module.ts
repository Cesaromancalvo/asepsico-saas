import { Module } from '@nestjs/common';
import { WorkspaceMembersController } from './workspace-members.controller';
import { WorkspaceMembersService } from './workspace-members.service';

@Module({ controllers: [WorkspaceMembersController], providers: [WorkspaceMembersService] })
export class WorkspaceMembersModule {}
