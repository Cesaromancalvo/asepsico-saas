import { Module } from '@nestjs/common';
import { PortalModule } from '../portal/portal.module';
import { AppointmentRequestsService } from './appointment-requests.service';
import { AvailabilityService } from './availability.service';
import { PortalBookingService } from './portal-booking.service';
import { PortalRateLimitGuard } from './portal-rate-limit.guard';
import { PortalBookingController, SchedulingController } from './scheduling.controller';

@Module({
  imports: [PortalModule],
  controllers: [SchedulingController, PortalBookingController],
  providers: [AvailabilityService, AppointmentRequestsService, PortalBookingService, PortalRateLimitGuard],
})
export class SchedulingModule {}
