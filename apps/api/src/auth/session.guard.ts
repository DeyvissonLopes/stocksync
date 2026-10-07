import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { AuthTokenService } from './auth-token.service.js';
import type { AuthenticatedIdentity } from './credential-verifier.js';
import { UserEntity } from '../database/entities/user.entity.js';

export type AuthenticatedRequest = {
  headers: { cookie?: string };
  identity: AuthenticatedIdentity;
};

function sessionToken(cookieHeader: string | undefined): string | null {
  let token: string | undefined;
  for (const cookie of cookieHeader?.split(';') ?? []) {
    const separator = cookie.indexOf('=');
    if (separator === -1 || cookie.slice(0, separator).trim() !== 'stocksync_token') continue;
    if (token !== undefined) return null;
    token = cookie.slice(separator + 1).trim();
  }
  return token || null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly tokenService: AuthTokenService,
    @InjectRepository(UserEntity) private readonly userRepository: Repository<UserEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    response.setHeader('Cache-Control', 'no-store');
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = sessionToken(request.headers.cookie);
    if (!token) throw new UnauthorizedException();

    const userId = this.tokenService.verify(token);
    if (!userId) throw new UnauthorizedException();

    const user = await this.userRepository.findOne({
      where: { id: userId, isActive: true },
      select: { id: true, tenantId: true, role: true },
    });
    if (!user) throw new UnauthorizedException();
    request.identity = { userId: user.id, tenantId: user.tenantId, role: user.role };
    return true;
  }
}
