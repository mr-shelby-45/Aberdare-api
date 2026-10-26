import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, NotEquals } from 'class-validator';
import { ADJUST_REASONS, type AdjustReason } from '../stock.repository.js';

// stock.adjust (docs/phase-c-design.md section 5): a signed change with a
// reason. Whether the sign fits the reason is a rule (REASON_SIGN_MISMATCH).
export class AdjustStockDto {
  @IsUUID()
  location_id!: string;

  @IsUUID()
  pack_type_id!: string;

  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  @NotEquals(0)
  quantity_change!: number;

  @IsIn(ADJUST_REASONS)
  reason!: AdjustReason;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}
