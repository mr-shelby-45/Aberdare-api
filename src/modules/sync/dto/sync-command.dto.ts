import { IsISO8601, IsObject, IsString, IsUUID, MaxLength } from 'class-validator';

// The envelope of one phone command. The payload is validated separately by
// the handler for its type.
export class SyncCommandDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  @MaxLength(64)
  type!: string;

  // When the phone says it happened (Phase B1: stored from the first command
  // on, because it cannot be backfilled). Range rules come in B2.
  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}
