import { createParamDecorator, ExecutionContext } from '@nestjs/common';
/** `sid`: sesión de autenticación (familia del refresh token). Tokens anteriores no lo llevan. */
export type AuthUser = { sub: string; workspaceId: string; role: string; email: string; sid?: string };
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
