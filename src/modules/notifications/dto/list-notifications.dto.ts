import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GET /v1/notifications (docs/phase-f-design.md section 5). Unknown query
// parameters, such as business_id, are refused by the global validation pipe.
export class ListNotificationsQueryDto {
  // true: only unread; false or left out: all.
  @IsOptional()
  @IsIn(['true', 'false'])
  unread?: 'true' | 'false';

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}
