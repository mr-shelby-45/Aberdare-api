import { IsString, MaxLength } from 'class-validator';

// barcode.remove (docs/phase-b-design.md section 5).
export class RemoveBarcodeDto {
  // Normalised and checked by normalizeBarcode().
  @IsString()
  @MaxLength(200)
  barcode!: string;
}
