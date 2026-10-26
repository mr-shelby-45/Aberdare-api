import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { MOVEMENT_TYPES, type MovementType } from '../stock.repository.js';

// GET /v1/stock/movements (docs/phase-c-design.md section 7). from and to
// are times on occurred_at: from inclusive, to exclusive.
export class ListMovementsQueryDto {
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  pack_type_id?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  type?: MovementType;

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
