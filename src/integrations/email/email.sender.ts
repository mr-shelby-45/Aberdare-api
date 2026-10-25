// Sends one email. The only way the app talks to an email provider
// (docs/phase-a-design.md section 13). Call it after the database commit,
// never inside a transaction. Phase A uses FakeEmailSender; the provider and
// sending domain are chosen before launch.
export abstract class EmailSender {
  abstract send(to: string, message: string): Promise<void>;
}
