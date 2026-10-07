import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { prepareSaleRequest } from './sale-request.js';
import { SaleWriter } from './sale-writer.js';

@Controller('sales')
@UseGuards(SessionGuard)
export class SalesController {
  constructor(private readonly writer: SaleWriter) {}

  @Post()
  async create(@Headers('idempotency-key') key: unknown, @Body() body: unknown,
    @Req() request: AuthenticatedRequest) {
    const prepared = prepareSaleRequest(key, body, request.identity.userId);
    const sale = await this.writer.create(request.identity.tenantId, request.identity.userId,
      prepared);
    return { sale };
  }
}
