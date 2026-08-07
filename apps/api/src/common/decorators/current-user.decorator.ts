import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export type AuthUser = { sub: string; workspaceId: string; role: string; email: string };
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
