import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { describeTrustProxy, parseTrustProxy } from './config/trust-proxy';

async function bootstrap() {
  // Se valida ANTES de crear la app: un TRUST_PROXY mal escrito debe impedir el arranque, no
  // dejar el rate limiting por IP abierto (o compartido entre todos) en silencio.
  // Ver src/config/trust-proxy.ts y ops/PILOT_RUNBOOK.md (topología de Render).
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV);

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');

  // Detrás del proxy de Render, req.ip (clave del ThrottlerGuard) debe ser la IP del cliente que
  // añade el proxy, nunca una entrada de X-Forwarded-For escrita por el propio cliente.
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  new Logger('Bootstrap').log(`trust proxy: ${describeTrustProxy(trustProxy)}`);

  app.use(cookieParser());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle('AsePsico API')
    .setDescription('API del sistema operativo para la práctica psicológica')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(Number(process.env.API_PORT ?? 4000));
}
bootstrap();
