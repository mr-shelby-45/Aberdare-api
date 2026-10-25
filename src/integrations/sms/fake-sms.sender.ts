import { Injectable } from '@nestjs/common';
import { SmsSender } from './sms.sender.js';

// Keeps messages in memory for tests to read. Never logs them: a message holds
// a code (docs/phase-a-design.md section 10).
@Injectable()
export class FakeSmsSender extends SmsSender {
  readonly outbox: { to: string; message: string }[] = [];

  async send(to: string, message: string): Promise<void> {
    this.outbox.push({ to, message });
  }
}
