import { IsIn, IsOptional, IsUUID } from 'class-validator';

// GET /v1/reports/stock (docs/phase-g1-design.md section 5). Stock on hand
// now, so no date range. include_zero and include_archived default to false,
// as in GET /v1/stock, so the two agree for the same filters. Unknown
// parameters, such as business_id, are refused.
export class StockReportQueryDto {
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  include_zero?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: 'true' | 'false';

  @IsOptional()
  @IsIn(['product', 'location'])
  group_by?: 'product' | 'location';
}
