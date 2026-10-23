import { Module } from '@nestjs/common';
import { IntakeLinksService } from './intake-links.service';
import { PortalActivationService } from './portal-activation.service';
import { PortalAccountEmailService } from './portal-account-email.service';
import { PortalSignupController, PublicPortalSignupController } from './portal-signup.controller';
import { SignupRequestsService } from './signup-requests.service';
import { PortalSignupCleanupService } from './portal-signup-cleanup.service';

/** Alta en el portal con el QR fijo del profesional (solicitud → revisión → activación). */
@Module({
  controllers: [PortalSignupController, PublicPortalSignupController],
  providers: [IntakeLinksService, SignupRequestsService, PortalActivationService, PortalAccountEmailService, PortalSignupCleanupService],
  exports: [SignupRequestsService],
})
export class PortalSignupModule {}
