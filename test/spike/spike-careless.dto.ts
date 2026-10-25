import { IsOptional, IsString, MaxLength } from 'class-validator';

// Every credential field name the auth routes use (A5 test 3).
export class SpikeCarelessDto {
  @IsOptional() @IsString() @MaxLength(4096) password?: string;
  @IsOptional() @IsString() @MaxLength(4096) new_password?: string;
  @IsOptional() @IsString() @MaxLength(4096) pin?: string;
  @IsOptional() @IsString() @MaxLength(4096) new_pin?: string;
  @IsOptional() @IsString() @MaxLength(4096) temp_pin?: string;
  @IsOptional() @IsString() @MaxLength(4096) code?: string;
  @IsOptional() @IsString() @MaxLength(4096) phone_code?: string;
  @IsOptional() @IsString() @MaxLength(4096) email_code?: string;
  @IsOptional() @IsString() @MaxLength(4096) access_token?: string;
  @IsOptional() @IsString() @MaxLength(4096) refresh_token?: string;
  @IsOptional() @IsString() @MaxLength(4096) device_secret?: string;
  @IsOptional() @IsString() @MaxLength(4096) signup_token?: string;
  @IsOptional() @IsString() @MaxLength(4096) setup_token?: string;
  @IsOptional() @IsString() @MaxLength(4096) selection_token?: string;
}
