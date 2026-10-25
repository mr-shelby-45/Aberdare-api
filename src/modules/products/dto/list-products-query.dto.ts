import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GET /v1/products. Query strings are text, so nothing is coerced here; the
// service applies the rules (q 2 to 100 characters, limit 1 to 50 with a cap,
// cursor only without q). Unknown parameters, including business_id, are
// refused by the validation pipe (decided in B4).
export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  q?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: 'true' | 'false';
}
