import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateStaffDto {
  // Kenyan mobile in any common form; normalised to E.164 by the service.
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsString()
  @Length(1, 40)
  display_name!: string;

  // The owner is created at signup only.
  @IsIn(['MANAGER', 'ATTENDANT', 'FIELD_ATTENDANT'])
  role_preset!: 'MANAGER' | 'ATTENDANT' | 'FIELD_ATTENDANT';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  extra_permissions?: string[];
}
