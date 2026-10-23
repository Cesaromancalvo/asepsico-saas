import { createParamDecorator, ExecutionContext } from '@nestjs/common';
/**
 * `sid`: sesión de autenticación (familia del refresh token). `tv`: User.tokenVersion al emitir el
 * token (JwtAuthGuard lo compara con la BD). Los tokens anteriores no llevan ninguno de los dos.
 */
export type AuthUser = { sub: string; workspaceId: string; role: string; email: string; sid?: string; tv?: number };
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
