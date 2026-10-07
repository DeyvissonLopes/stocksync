import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthTokenModule } from '../auth/auth-token.module.js';
import { SessionGuard } from '../auth/session.guard.js';
import { UserEntity } from '../database/entities/user.entity.js';
import { SalesController } from './sales.controller.js';
import { SaleWriter } from './sale-writer.js';

@Module({
  imports: [AuthTokenModule, TypeOrmModule.forFeature([UserEntity])],
  controllers: [SalesController],
  providers: [SaleWriter, SessionGuard],
})
export class SalesModule {}
