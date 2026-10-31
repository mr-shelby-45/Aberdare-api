import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

/** The channel notify() signals on, with the business id as payload (Phase F3). */
export const NOTIFICATION_DUE_CHANNEL = 'notification_due';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECONNECT_MS = 5_000;

// The worker's wake-up (Phase F3, docs/phase-f-design.md section 5): one
// connection that LISTENs for notification_due. notify() sends the signal in
// the event's transaction, and Postgres delivers it only when that commits.
// It connects as queue_user (CONNECT is all LISTEN needs). A lost signal is
// not a lost push: the sweeper finds every due row within a minute. Lives in
// the database layer because only it may import pg.
@Injectable()
export class NotificationDueListener implements OnModuleDestroy {
  private client: pg.Client | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  async start(connectionString: string, onDue: (businessId: string) => void, onError: (err: unknown) => void): Promise<void> {
    this.stopped = false;
    const client = new pg.Client({ connectionString, application_name: 'worker-listener' });
    client.on('notification', (m) => {
      if (m.channel === NOTIFICATION_DUE_CHANNEL && m.payload && UUID.test(m.payload)) onDue(m.payload);
    });
    client.on('error', (err) => {
      onError(err);
      this.reconnectLater(connectionString, onDue, onError);
    });
    await client.connect();
    await client.query(`LISTEN ${NOTIFICATION_DUE_CHANNEL}`);
    this.client = client;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private reconnectLater(connectionString: string, onDue: (businessId: string) => void, onError: (err: unknown) => void): void {
    const old = this.client;
    this.client = null;
    void old?.end().catch(() => undefined);
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.start(connectionString, onDue, onError).catch((err: unknown) => {
        onError(err);
        this.reconnectLater(connectionString, onDue, onError);
      });
    }, RECONNECT_MS);
  }
}
