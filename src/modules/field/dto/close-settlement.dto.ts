import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { MONEY_PATTERN } from '../../../common/validation/money.js';

// One counted pack type. Only the shape is checked here; the range and the
// pack type are line checks, so every bad line is reported at once.
export class SettlementLineDto {
  @IsUUID()
  pack_type_id!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  counted_quantity!: number;
}

// settlement.close (docs/phase-t-design.md section 6). settlement_id is the
// phone's UUID; cash_received is KES as a string, never negative.
export class CloseSettlementDto {
  @IsUUID()
  settlement_id!: string;

  @IsUUID()
  field_location_id!: string;

  @IsString()
  @Matches(MONEY_PATTERN)
  cash_received!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SettlementLineDto)
  lines!: SettlementLineDto[];
}
