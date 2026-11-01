import { IsIn, IsOptional, Matches } from 'class-validator';

// GET /v1/reports/profit (docs/phase-g1-design.md section 5). from and to as
// in the sales report. Unknown parameters, such as business_id, are refused.
export class ProfitQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsIn(['day', 'product', 'attendant'])
  group_by?: 'day' | 'product' | 'attendant';
}
