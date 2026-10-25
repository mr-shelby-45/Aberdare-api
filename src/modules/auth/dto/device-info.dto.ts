import { IsIn, IsString, Length } from 'class-validator';

// The device being registered at signup or login.
export class DeviceInfoDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsIn(['android', 'ios'])
  platform!: string;
}
