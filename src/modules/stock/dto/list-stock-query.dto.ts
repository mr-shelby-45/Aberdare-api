import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

// GET /v1/stock (docs/phase-c-design.md section 7). Query strings are text,
// so nothing is coerced here; the service applies the limit rules. Unknown
// parameters, including business_id, are refused by the validation pipe.
export class ListStockQueryDto {
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  include_zero?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: 'true' | 'false';

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}
