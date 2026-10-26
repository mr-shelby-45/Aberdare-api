import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// One line of a delivery. Only the shape is checked here; a bad value is
// reported per line by StockCommandsService (QUANTITY_INVALID, COST_INVALID),
// so the shopkeeper sees every bad line at once (docs/phase-c-design.md section 5).
export class ReceiveLineDto {
  @IsUUID()
  pack_type_id!: string;

  // Any JSON number here; whole and 1 to 1,000,000 is a line check. The
  // string "5" is not a number and fails the whole command.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  quantity!: number;

  // KES as a string; its format is a line check. Present (even null) needs costs.view.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit_cost?: string | null;
}

// stock.receive: one delivery, 1 to 50 lines, all or nothing.
export class ReceiveStockDto {
  @IsUUID()
  location_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  reference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
}
