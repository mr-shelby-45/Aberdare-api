import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';

// The request body of POST /v1/sync/commands. Each command is validated on its
// own by SyncService, so one bad command never rejects the whole batch.
export class SyncBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  commands!: unknown[];
}
