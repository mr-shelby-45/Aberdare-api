import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  is_shared?: boolean;
}
