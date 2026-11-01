import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

// GET /v1/reports/sales (docs/phase-g1-design.md section 5). from and to are
// inclusive Africa/Nairobi days, both required; the service checks that they
// are real dates, in order and at most 92 days apart. Unknown parameters,
// such as business_id, are refused by the global validation pipe.
export class SalesReportQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsIn(['day', 'attendant', 'location'])
  group_by?: 'day' | 'attendant' | 'location';

  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  attendant_id?: string;
}
