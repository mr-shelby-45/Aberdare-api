/** What a push provider answered: sent, try again later, the token is no longer valid, or a failure (retried). */
export type PushResult = 'OK' | 'RETRY' | 'DEAD_TOKEN' | 'FAILED';

/** The push itself: ids, counts and a short English text only (docs/phase-f-design.md section 5). */
export interface PushMessage {
  notificationId: string;
  type: string;
  data: Record<string, unknown>;
  message: string;
}

// Sends one push to one device token. The only way the app talks to a push
// provider (Phase F3). Call it with no database transaction open. Phase F uses
// FakePushSender; the real provider (Firebase Cloud Messaging) comes later.
export abstract class PushSender {
  abstract send(token: string, push: PushMessage): Promise<PushResult>;
}
