import { Injectable } from '@nestjs/common';
import { currentTxIfAny } from '../../database/tenant.js';
import { type PushMessage, type PushResult, PushSender } from './push.sender.js';

/** A scripted answer: a result, a thrown error, or never answering. */
export type FakePushAnswer = PushResult | 'THROW' | 'HANG';

// Keeps every push it was asked to send, with the answer it gave, in memory
// for tests to read, and never logs them (a push holds a device token). Tests
// script answers per token; the default is OK. It records a violation if it
// is ever called inside a database transaction, which a sender must never be
// (docs/phase-f-design.md section 9).
@Injectable()
export class FakePushSender extends PushSender {
  readonly outbox: { token: string; push: PushMessage; answer: PushResult }[] = [];
  readonly calledInsideTransaction: string[] = [];
  private readonly scripts = new Map<string, FakePushAnswer[]>();
  private readonly calls = new Map<string, number>();
  /**
   * Phase F6, tests only: decides the answer from the notification and how
   * often it was asked to send it (1, 2, ...). A script for the token wins.
   */
  decide: ((push: PushMessage, call: number, token: string) => FakePushAnswer) | null = null;

  /** The next answers for this token, in order; after them, OK. */
  script(token: string, ...answers: FakePushAnswer[]): void {
    this.scripts.set(token, [...(this.scripts.get(token) ?? []), ...answers]);
  }

  reset(): void {
    this.outbox.length = 0;
    this.calledInsideTransaction.length = 0;
    this.scripts.clear();
    this.calls.clear();
    this.decide = null;
  }

  async send(token: string, push: PushMessage): Promise<PushResult> {
    if (currentTxIfAny()) this.calledInsideTransaction.push(push.notificationId);
    const call = (this.calls.get(push.notificationId) ?? 0) + 1;
    this.calls.set(push.notificationId, call);
    const answer = this.scripts.get(token)?.shift() ?? this.decide?.(push, call, token) ?? 'OK';
    if (answer === 'THROW') throw new Error('fake push provider failed');
    if (answer === 'HANG') return new Promise<PushResult>(() => undefined);
    this.outbox.push({ token, push, answer });
    return answer;
  }
}
