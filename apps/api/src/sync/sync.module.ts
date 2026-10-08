import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthTokenModule } from '../auth/auth-token.module.js';
import { SessionGuard } from '../auth/session.guard.js';
import { UserEntity } from '../database/entities/user.entity.js';
import { SyncController } from './sync.controller.js';
import { SyncStatusReader } from './sync-status-reader.js';

@Module({
  imports: [AuthTokenModule, TypeOrmModule.forFeature([UserEntity])],
  controllers: [SyncController],
  providers: [SessionGuard, SyncStatusReader],
})
export class SyncModule {}
