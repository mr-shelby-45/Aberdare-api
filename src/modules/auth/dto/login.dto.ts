import { Type } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto.js';

// Two forms (docs/phase-a-design.md section 6):
//   { email, password, device, membership_id? }       first call
//   { selection_token, membership_id, device }         after requires_selection
export class LoginDto {
  @ValidateIf((o: LoginDto) => o.selection_token === undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ValidateIf((o: LoginDto) => o.selection_token === undefined)
  @IsString()
  @Length(1, 128)
  password?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2048)
  selection_token?: string;

  @ValidateIf((o: LoginDto) => o.selection_token !== undefined || o.membership_id !== undefined)
  @IsUUID()
  membership_id?: string;

  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device!: DeviceInfoDto;
}
