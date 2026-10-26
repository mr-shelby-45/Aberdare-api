import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GET /v1/sync/changes (docs/phase-d-design.md section 6). cursor is
// required (a phone starts from the snapshot's start_cursor). Unknown
// parameters, including business_id, are refused by the validation pipe.
export class ChangesQueryDto {
  @IsString()
  @MaxLength(2000)
  cursor!: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;
}
