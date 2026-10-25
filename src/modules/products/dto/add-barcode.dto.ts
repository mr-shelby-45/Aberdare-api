import { IsString, IsUUID, MaxLength } from 'class-validator';

// barcode.add (docs/phase-b-design.md section 5).
export class AddBarcodeDto {
  // Normalised and checked by normalizeBarcode().
  @IsString()
  @MaxLength(200)
  barcode!: string;

  @IsUUID()
  product_id!: string;

  @IsUUID()
  pack_type_id!: string;
}
