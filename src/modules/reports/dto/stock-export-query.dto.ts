import { IsIn, IsOptional, IsUUID } from 'class-validator';

// GET /v1/reports/stock/export.csv (docs/phase-g1-design.md section 5). The
// same filters and defaults as the stock report and GET /v1/stock (zero
// balances and archived products left out unless asked). Unknown parameters
// are refused.
export class StockExportQueryDto {
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  include_zero?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: 'true' | 'false';
}
