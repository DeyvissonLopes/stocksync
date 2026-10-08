import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { SyncStatusReader } from './sync-status-reader.js';

@Controller('sync')
@UseGuards(SessionGuard)
export class SyncController {
  constructor(private readonly reader: SyncStatusReader) {}

  @Get('status')
  status(@Query() query: Record<string, unknown>, @Req() request: AuthenticatedRequest) {
    if (Object.keys(query).length !== 0) throw new BadRequestException('Invalid sync query');
    return this.reader.read(request.identity.tenantId);
  }
}
