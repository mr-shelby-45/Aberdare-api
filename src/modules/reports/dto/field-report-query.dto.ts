import { IsOptional, IsUUID, Matches } from 'class-validator';

// GET /v1/reports/field (docs/phase-g1-design.md section 5). from and to as
// in the sales report, applied to the settlements' period_end. Unknown
// parameters, such as business_id, are refused.
export class FieldReportQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsUUID()
  attendant_id?: string;
}
