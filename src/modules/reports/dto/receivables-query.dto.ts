import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GET /v1/reports/receivables (docs/phase-g1-design.md section 5). from and
// to are optional but go together: without them the report covers all time
// (an old debt must not drop out of sight); with them, Nairobi days of the
// sale (unpaid) or of the payment (unverified_mpesa), at most 92 days. limit
// and cursor as in the exceptions report. Unknown parameters are refused.
export class ReceivablesQueryDto {
  @IsIn(['unpaid', 'unverified_mpesa'])
  type!: 'unpaid' | 'unverified_mpesa';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}
