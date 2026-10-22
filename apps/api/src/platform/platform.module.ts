import { Module } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformController } from './platform.controller';
import { PlatformWaitlistService } from './platform-waitlist.service';

/** Capacidad de plataforma PLATFORM_ADMIN: panel privado de la lista de espera. Ver platform-admin.config.ts. */
@Module({ controllers: [PlatformController], providers: [PlatformWaitlistService, PlatformAdminGuard] })
export class PlatformModule {}
