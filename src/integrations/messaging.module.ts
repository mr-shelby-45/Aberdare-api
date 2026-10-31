import { Module } from '@nestjs/common';
import { EmailSender } from './email/email.sender.js';
import { FakeEmailSender } from './email/fake-email.sender.js';
import { FakePushSender } from './push/fake-push.sender.js';
import { PushSender } from './push/push.sender.js';
import { FakeSmsSender } from './sms/fake-sms.sender.js';
import { SmsSender } from './sms/sms.sender.js';

// Phase A: fake senders only (docs/phase-a-design.md section 13); Phase F3 adds
// the push sender, also a fake. Swapping in a real provider later only changes
// this file.
@Module({
  providers: [
    { provide: SmsSender, useClass: FakeSmsSender },
    { provide: EmailSender, useClass: FakeEmailSender },
    { provide: PushSender, useClass: FakePushSender },
  ],
  exports: [SmsSender, EmailSender, PushSender],
})
export class MessagingModule {}
