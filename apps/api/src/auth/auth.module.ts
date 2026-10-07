import { Module } from '@nestjs/common';
import { minutes, seconds, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthTokenModule } from './auth-token.module.js';
import { AuthController } from './auth.controller.js';
import { CredentialVerifier } from './credential-verifier.js';
import { LoginThrottlerGuard } from './login-throttler.guard.js';
import { ConfigModule } from '../config/config.module.js';
import { UserEntity } from '../database/entities/user.entity.js';

@Module({
  imports: [
    ConfigModule,
    AuthTokenModule,
    TypeOrmModule.forFeature([UserEntity]),
    ThrottlerModule.forRoot({
      errorMessage: 'Too many login attempts',
      setHeaders: false,
      throttlers: [
        { name: 'ip', ttl: minutes(15), limit: 30 },
        {
          name: 'email', ttl: minutes(15), limit: 5, blockDuration: seconds(30),
          getTracker: (request) => {
            const body: unknown = request.body;
            if (typeof body === 'object' && body !== null && 'email' in body &&
              typeof body.email === 'string') return body.email;
            return typeof request.ip === 'string' ? request.ip : 'unknown';
          },
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [CredentialVerifier, LoginThrottlerGuard],
})
export class AuthModule {}
