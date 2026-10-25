import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

export class PasswordResetDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Matches(/^\d{6}$/)
  code!: string;

  // Same rules as at signup (docs/phase-a-design.md section 10).
  @IsString()
  @Length(10, 128)
  new_password!: string;
}
