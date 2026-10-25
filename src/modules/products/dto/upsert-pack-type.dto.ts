import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { MONEY_PATTERN } from '../../../common/validation/money.js';

// pack_type.upsert (docs/phase-b-design.md section 5): creates the pack type
// if its id is new, otherwise replaces name, units and sell price.
export class UpsertPackTypeDto {
  @IsUUID()
  pack_type_id!: string;

  @IsUUID()
  product_id!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(10_000)
  units_per_pack!: number;

  @IsString()
  @Matches(MONEY_PATTERN)
  sell_price!: string;

  // Omitted: unchanged. null: cleared. Present either way needs costs.view.
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  cost_price?: string | null;

  @ValidateIf((o: UpsertPackTypeDto) => o.archived !== undefined)
  @IsBoolean()
  archived?: boolean;
}
