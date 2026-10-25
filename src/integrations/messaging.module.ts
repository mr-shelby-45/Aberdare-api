import { Module } from '@nestjs/common';
import { EmailSender } from './email/email.sender.js';
import { FakeEmailSender } from './email/fake-email.sender.js';
import { FakeSmsSender } from './sms/fake-sms.sender.js';
import { SmsSender } from './sms/sms.sender.js';

// Phase A: fake senders only (docs/phase-a-design.md section 13). Swapping in a
// real provider later only changes this file.
@Module({
  providers: [
    { provide: SmsSender, useClass: FakeSmsSender },
    { provide: EmailSender, useClass: FakeEmailSender },
  ],
  exports: [SmsSender, EmailSender],
})
export class MessagingModule {}
