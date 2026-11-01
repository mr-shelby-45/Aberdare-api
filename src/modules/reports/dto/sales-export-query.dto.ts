import { IsOptional, IsUUID, Matches } from 'class-validator';

// GET /v1/reports/sales/export.csv (docs/phase-g1-design.md section 5). from
// and to as in the sales report. Unknown parameters are refused.
export class SalesExportQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  attendant_id?: string;
}
