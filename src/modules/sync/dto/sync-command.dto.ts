import { IsObject, IsString, IsUUID, MaxLength } from 'class-validator';

// The envelope of one phone command. The payload is validated separately by
// the handler for its type.
export class SyncCommandDto {
  @IsUUID()
  commandId!: string;

  @IsString()
  @MaxLength(64)
  type!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}
