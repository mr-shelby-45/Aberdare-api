import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GET /v1/reports/exceptions (docs/phase-g1-design.md section 5). from and to
// as in the sales report (voids by voided_at, below-list lines by the sale's
// occurred_at); limit 1 to 100 (default 20), checked by the service; cursor
// as given by the previous page. Unknown parameters are refused.
export class ExceptionsQueryDto {
  @IsIn(['voids', 'below_list'])
  type!: 'voids' | 'below_list';

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}
