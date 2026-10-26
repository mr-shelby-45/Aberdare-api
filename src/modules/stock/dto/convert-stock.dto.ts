import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

// stock.convert (docs/phase-c-design.md section 5): `quantity` larger packs
// broken into the smaller pack type, at one location.
export class ConvertStockDto {
  @IsUUID()
  location_id!: string;

  @IsUUID()
  from_pack_type_id!: string;

  @IsUUID()
  to_pack_type_id!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  // An attendant's approval (C5). Accepted since C4 so the payload never
  // changes; ignored and not consumed when the member has stock.convert.
  @IsOptional()
  @IsUUID()
  approval_id?: string;
}
