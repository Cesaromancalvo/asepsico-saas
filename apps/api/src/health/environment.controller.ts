import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * ¿Es un entorno de prueba (piloto demo, solo datos inventados)? La web lo lee en
 * GET /api/v1/environment para pintar el aviso fijo "Entorno de prueba".
 *
 * Falla hacia el lado seguro: SOLO DEMO_ENVIRONMENT=false exacto lo desactiva. Sin definir, vacío
 * o con cualquier otro valor, el aviso se muestra. Se quita únicamente en el entorno del piloto
 * real, con el contrato art. 28 aceptado.
 */
export function isDemoEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_ENVIRONMENT !== 'false';
}

// Público y sin datos sensibles: solo banderas de presentación que la web necesita incluso antes
// de iniciar sesión (contrato PublicEnvironmentContract en packages/contracts).
@ApiTags('health')
@Controller('environment')
export class EnvironmentController {
  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  get(): { demo: boolean } {
    return { demo: isDemoEnvironment() };
  }
}
