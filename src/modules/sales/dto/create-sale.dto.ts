import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../common/validation/money.js';
import { PaymentDto } from '../../payments/dto/payment.dto.js';

// One line of a sale. Only the shape is checked here; a bad value is reported
// per line by SalesService (QUANTITY_INVALID, PRICE_INVALID), so the phone
// sees every bad line at once (docs/phase-e-design.md section 5).
export class SaleLineDto {
  @IsUUID()
  pack_type_id!: string;

  // Any JSON number here; whole and 1 to 100,000 is a line check.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  quantity!: number;

  // KES as a string; its format is a line check.
  @IsString()
  @MaxLength(40)
  unit_price!: string;
}

// sale.create (docs/phase-e-design.md section 5): 1 to 100 lines, 0 to 10
// payments (Phase E3; payments need payments.confirm as well).
export class CreateSaleDto {
  @IsUUID()
  sale_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(30)
  local_ref!: string;

  @IsUUID()
  location_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  // The phone's total, only compared. A malformed one fails the command.
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  total?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines!: SaleLineDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PaymentDto)
  payments?: PaymentDto[];
}
