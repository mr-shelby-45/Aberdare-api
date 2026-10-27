import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @Length(1, 40)
  display_name?: string;

  @IsOptional()
  @IsIn(['MANAGER', 'ATTENDANT', 'FIELD_ATTENDANT'])
  role_preset?: 'MANAGER' | 'ATTENDANT' | 'FIELD_ATTENDANT';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  extra_permissions?: string[];
}
