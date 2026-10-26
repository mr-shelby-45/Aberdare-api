import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SYNC_TABLE_NAMES, type SyncTableName } from '../sync-tables.js';

// GET /v1/sync/snapshot (docs/phase-d-design.md section 5). Query strings are
// text, so nothing is coerced here. Unknown parameters, including
// business_id, are refused by the validation pipe.
export class SnapshotQueryDto {
  @IsOptional()
  @IsIn(SYNC_TABLE_NAMES)
  table?: SyncTableName;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;
}
