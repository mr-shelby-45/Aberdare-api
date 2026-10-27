import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

// One line of an issue or return. Only the shape is checked here; a bad value
// is a line reason (QUANTITY_INVALID and the others), so every bad line is
// reported at once (the Phase C pattern).
export class TransferLineDto {
  @IsUUID()
  pack_type_id!: string;

  // Any JSON number here; whole and 1 to 1,000,000 is a line check.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  quantity!: number;
}

// stock.issue and stock.return (docs/phase-t-design.md section 5): 1 to 50
// lines, all or nothing.
export class TransferStockDto {
  @IsUUID()
  from_location_id!: string;

  @IsUUID()
  to_location_id!: string;

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
  @Type(() => TransferLineDto)
  lines!: TransferLineDto[];
}
