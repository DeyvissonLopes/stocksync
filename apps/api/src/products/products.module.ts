import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthTokenModule } from '../auth/auth-token.module.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ProductEntity } from '../database/entities/product.entity.js';
import { UserEntity } from '../database/entities/user.entity.js';
import { ProductReader } from './product-reader.js';
import { ProductWriter } from './product-writer.js';
import { ProductsController } from './products.controller.js';

@Module({
  imports: [AuthTokenModule, TypeOrmModule.forFeature([ProductEntity, UserEntity])],
  controllers: [ProductsController],
  providers: [ProductReader, ProductWriter, SessionGuard],
})
export class ProductsModule {}
