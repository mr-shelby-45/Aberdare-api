import { Injectable } from '@nestjs/common';

// The one source of "now" for business logic: lockouts, expiries and rate
// windows (docs/phase-a-design.md section 19). Tests replace it with a clock
// they move forward, instead of sleeping. Always UTC (CLAUDE.md rule 11).
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
