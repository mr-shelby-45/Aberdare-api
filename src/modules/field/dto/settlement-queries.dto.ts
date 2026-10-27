import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

// GET /v1/field/settlements/preview (docs/phase-t-design.md section 6).
export class PreviewQueryDto {
  @IsUUID()
  location_id!: string;
}

// GET /v1/field/settlements: newest first, signed cursor bound to the filter.
export class ListSettlementsQueryDto {
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/)
  limit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cursor?: string;
}
