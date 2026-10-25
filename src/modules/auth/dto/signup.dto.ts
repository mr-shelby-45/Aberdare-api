import { Type } from 'class-transformer';
import { IsIn, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto.js';

export class SignupDto {
  @IsString()
  @Length(1, 2048)
  signup_token!: string;

  @IsString()
  @Length(1, 60)
  owner_name!: string;

  @IsString()
  @Length(1, 100)
  business_name!: string;

  @IsIn(['RETAIL', 'WHOLESALE', 'WAREHOUSE'])
  business_type!: 'RETAIL' | 'WHOLESALE' | 'WAREHOUSE';

  // 10 to 128 characters (docs/phase-a-design.md section 10); the service
  // also rejects a password equal to the phone, email or email local part.
  @IsString()
  @Length(10, 128)
  password!: string;

  @Matches(/^\d{4}$/)
  pin!: string;

  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device!: DeviceInfoDto;
}
