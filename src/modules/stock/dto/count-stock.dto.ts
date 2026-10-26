import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

// One counted pool. Only the shape is checked here; the ranges are line
// checks in StockCommandsService (QUANTITY_INVALID), so every bad line is
// reported at once.
export class CountLineDto {
  @IsUUID()
  pack_type_id!: string;

  // The phone's own balance for this pool when it counted. May be negative.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  expected_quantity!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  counted_quantity!: number;
}

// stock.count (docs/phase-c-design.md section 5): 1 to 50 lines, all or nothing.
export class CountStockDto {
  @IsUUID()
  location_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CountLineDto)
  lines!: CountLineDto[];
}
