import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

// GET /v1/sales (docs/phase-e-design.md section 7). from and to are times on
// occurred_at: from inclusive, to exclusive. created_by is honoured only for
// members with sales.void.
export class ListSalesQueryDto {
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsIn(['COMPLETED', 'VOIDED'])
  status?: 'COMPLETED' | 'VOIDED';

  @IsOptional()
  @IsUUID()
  created_by?: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  to?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}
