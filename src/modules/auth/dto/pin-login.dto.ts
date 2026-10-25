import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class PinLoginDto {
  // Not checked as a UUID here: an unknown device must answer exactly like a
  // wrong PIN, so the service handles every shape the same way.
  @IsString()
  @Length(1, 64)
  device_id!: string;

  @IsString()
  @Length(1, 128)
  device_secret!: string;

  @Matches(/^\d{4}$/)
  pin!: string;

  @IsOptional()
  @IsUUID()
  membership_id?: string;
}
