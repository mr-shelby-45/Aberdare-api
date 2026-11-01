import { IsIn, IsOptional, Matches } from 'class-validator';

// GET /v1/reports/shrinkage (docs/phase-g1-design.md section 5). from and to
// as in the sales report, applied to the movements' occurred_at. Unknown
// parameters, such as business_id, are refused.
export class ShrinkageQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsIn(['reason', 'person', 'location', 'product'])
  group_by?: 'reason' | 'person' | 'location' | 'product';
}
