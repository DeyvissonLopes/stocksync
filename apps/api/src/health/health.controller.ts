import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  @Header('Cache-Control', 'no-store')
  check() {
    return { status: 'ok' };
  }
}
