import { Type } from 'class-transformer';
import { IsString, Length, Matches, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto.js';

export class ActivateDto {
  @IsString()
  @Length(1, 2048)
  setup_token!: string;

  @Matches(/^\d{6}$/)
  code!: string;

  @Matches(/^\d{4}$/)
  new_pin!: string;

  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device!: DeviceInfoDto;
}
