import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PortalController } from './portal.controller';
import { PortalGuard } from './portal.guard';
import { PortalService } from './portal.service';
import { getPortalJwtSecret } from './portal-jwt-secret.util';

@Module({
  imports: [
    // Secreto propio, distinto al de AuthModule: los tokens del portal del paciente y los
    // de staff son dominios de confianza separados y no deben poder verificarse entre sí.
    JwtModule.register({ secret: getPortalJwtSecret(), signOptions: { expiresIn: '30m' } }),
  ],
  controllers: [PortalController],
  providers: [PortalService, PortalGuard],
})
export class PortalModule {}

