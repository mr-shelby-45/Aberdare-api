// Sends one SMS. The only way the app talks to an SMS provider
// (docs/phase-a-design.md section 13). Call it after the database commit,
// never inside a transaction. Phase A uses FakeSmsSender; the real provider
// (Africa's Talking) comes later.
export abstract class SmsSender {
  abstract send(to: string, message: string): Promise<void>;
}
