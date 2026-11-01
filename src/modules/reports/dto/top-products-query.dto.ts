import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

// GET /v1/reports/top-products (docs/phase-g1-design.md section 5). from and
// to as in the sales report; limit 1 to 50 (default 10), checked by the
// service. Unknown parameters, such as business_id, are refused.
export class TopProductsQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsIn(['quantity', 'value'])
  by?: 'quantity' | 'value';

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsUUID()
  location_id?: string;
}
