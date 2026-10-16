import { Module } from '@nestjs/common';
import { EnvironmentController } from './environment.controller';
import { HealthController } from './health.controller';
@Module({ controllers: [HealthController, EnvironmentController] }) export class HealthModule {}
