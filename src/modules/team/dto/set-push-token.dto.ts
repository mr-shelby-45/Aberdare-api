import { IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

// PUT /v1/devices/me/push-token (Phase F3): the phone's push token, or null to clear it.
export class SetPushTokenDto {
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  push_token!: string | null;
}
