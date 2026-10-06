import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const issuer = 'stocksync-api';
const audience = 'stocksync-browser';
const lifetimeSeconds = 3600;
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthTokenService {
  constructor(private readonly jwt: JwtService) {}

  issue(userId: string): string {
    if (!userIdPattern.test(userId)) {
      throw new TypeError('Invalid user ID');
    }
    return this.jwt.sign({ sub: userId }, {
      algorithm: 'HS256', issuer, audience, expiresIn: lifetimeSeconds,
    });
  }

  verify(token: string): string | null {
    let claims: Record<string, unknown>;
    try {
      claims = this.jwt.verify<Record<string, unknown>>(token, {
        algorithms: ['HS256'], issuer, audience,
      });
    } catch {
      return null;
    }

    if (typeof claims.sub !== 'string' || !userIdPattern.test(claims.sub) ||
      typeof claims.iat !== 'number' || !Number.isInteger(claims.iat) ||
      typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) ||
      claims.exp - claims.iat !== lifetimeSeconds ||
      claims.iat > Math.floor(Date.now() / 1000) ||
      Object.keys(claims).sort().join(',') !== 'aud,exp,iat,iss,sub') {
      return null;
    }
    return claims.sub;
  }
}
