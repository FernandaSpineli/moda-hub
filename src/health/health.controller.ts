import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  /** Liveness: the process is up and serving requests. */
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
