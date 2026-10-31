import { Injectable } from '@nestjs/common';
import { currentTxIfAny } from '../../database/tenant.js';
import { type PushMessage, type PushResult, PushSender } from './push.sender.js';

/** A scripted answer: a result, a thrown error, or never answering. */
export type FakePushAnswer = PushResult | 'THROW' | 'HANG';

// Keeps pushes in memory for tests to read and never logs them (a push holds
// a device token). Tests script answers per token; the default is OK. It
// records a violation if it is ever called inside a database transaction,
// which a sender must never be (docs/phase-f-design.md section 9).
@Injectable()
export class FakePushSender extends PushSender {
  readonly outbox: { token: string; push: PushMessage }[] = [];
  readonly calledInsideTransaction: string[] = [];
  private readonly scripts = new Map<string, FakePushAnswer[]>();

  /** The next answers for this token, in order; after them, OK. */
  script(token: string, ...answers: FakePushAnswer[]): void {
    this.scripts.set(token, [...(this.scripts.get(token) ?? []), ...answers]);
  }

  reset(): void {
    this.outbox.length = 0;
    this.calledInsideTransaction.length = 0;
    this.scripts.clear();
  }

  async send(token: string, push: PushMessage): Promise<PushResult> {
    if (currentTxIfAny()) this.calledInsideTransaction.push(push.notificationId);
    const answer = this.scripts.get(token)?.shift() ?? 'OK';
    if (answer === 'THROW') throw new Error('fake push provider failed');
    if (answer === 'HANG') return new Promise<PushResult>(() => undefined);
    this.outbox.push({ token, push });
    return answer;
  }
}
