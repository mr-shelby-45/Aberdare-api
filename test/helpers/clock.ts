import { Clock } from '../../src/common/time/clock.js';

/** A clock tests move forward instead of sleeping (docs/phase-a-design.md section 19). */
export class FakeClock extends Clock {
  constructor(private current = new Date('2026-10-25T09:00:00.000Z')) {
    super();
  }

  override now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }
}
