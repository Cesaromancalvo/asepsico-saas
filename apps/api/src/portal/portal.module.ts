import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PortalController } from './portal.controller';
import { PortalGuard } from './portal.guard';
import { PortalService } from './portal.service';
import { getPortalJwtSecret } from './portal-jwt-secret.util';

@Module({
  imports: [
    JwtModule.register({
      secret: getPortalJwtSecret(),
      signOptions: { expiresIn: '30m' },
    }),
  ],
  controllers: [PortalController],
  providers: [PortalService, PortalGuard],
  exports: [
    JwtModule,
    PortalGuard,
    PortalService,
  ],
})
export class PortalModule {}