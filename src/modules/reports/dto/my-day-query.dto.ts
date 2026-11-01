import { IsOptional, Matches } from 'class-validator';

// GET /v1/reports/my-day (docs/phase-g1-design.md section 5). date is a
// Nairobi day within the last 7 days (today included); default today.
export class MyDayQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}
