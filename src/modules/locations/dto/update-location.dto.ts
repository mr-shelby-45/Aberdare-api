import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// Rename, archive (archived: true) or restore (archived: false).
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
