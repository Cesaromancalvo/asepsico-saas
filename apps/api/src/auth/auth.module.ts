import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegistrationService } from './registration.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { JwtStrategy } from './jwt.strategy';
import { getJwtSecret } from './jwt-secret.util';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, RegistrationService, MfaService, PasswordService, JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
