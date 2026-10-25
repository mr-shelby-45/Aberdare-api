import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MONEY_PATTERN } from '../../../common/validation/money.js';

// Text lengths are checked again after trimming by ProductsService.
export class PackTypeInputDto {
  @IsUUID()
  pack_type_id!: string;

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

  // Omitted: no cost price. Present (even null) needs costs.view.
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  cost_price?: string | null;
}

export class BarcodeInputDto {
  // Normalised and checked by normalizeBarcode().
  @IsString()
  @MaxLength(200)
  barcode!: string;

  // One of this command's pack types.
  @IsUUID()
  pack_type_id!: string;
}

// product.create (docs/phase-b-design.md section 5).
export class CreateProductDto {
  @IsUUID()
  product_id!: string;

  @IsString()
  @MaxLength(400)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sku?: string | null;

  // 1 to 6 by the catalogue rules; more than 6 is PACK_LIMIT_REACHED, so the
  // validator only bounds the work.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PackTypeInputDto)
  pack_types!: PackTypeInputDto[];

  @ValidateIf((o: CreateProductDto) => o.barcodes !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BarcodeInputDto)
  barcodes?: BarcodeInputDto[];
}
