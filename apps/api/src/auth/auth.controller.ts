import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, Res,
  UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthTokenService } from './auth-token.service.js';
import { CredentialVerifier } from './credential-verifier.js';
import { LoginThrottlerGuard } from './login-throttler.guard.js';
import { SessionGuard } from './session.guard.js';
import type { AuthenticatedRequest } from './session.guard.js';
import { sessionCookie } from './session-cookie.js';
import { APP_CONFIG } from '../config/app-config.js';
import type { AppConfig } from '../config/app-config.js';

type LoginRequest = { email: string; password: string };
type HttpResponse = { setHeader(name: string, value: string): void };

function parseLoginRequest(body: unknown): LoginRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'email,password' ||
    !('email' in body) || typeof body.email !== 'string' ||
    !('password' in body) || typeof body.password !== 'string' ||
    body.email.length === 0 || body.email.includes('\0') || body.password.length === 0 ||
    Buffer.byteLength(body.email, 'utf8') > 1024 ||
    Buffer.byteLength(body.password, 'utf8') > 1024) {
    throw new BadRequestException('Invalid login request');
  }
  return { email: body.email, password: body.password };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly verifier: CredentialVerifier,
    private readonly tokens: AuthTokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @UseGuards(LoginThrottlerGuard)
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: HttpResponse) {
    response.setHeader('Cache-Control', 'no-store');
    const { email, password } = parseLoginRequest(body);
    const identity = await this.verifier.verify(email, password);
    if (!identity) throw new UnauthorizedException('Invalid credentials');
    const token = this.tokens.issue(identity.userId);
    response.setHeader('Set-Cookie', sessionCookie(token, this.config.nodeEnv));
    return { user: identity };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthenticatedRequest) {
    return { user: request.identity };
  }
}
