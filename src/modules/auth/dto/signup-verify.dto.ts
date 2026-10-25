import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';

export class SignupVerifyDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Matches(/^\d{6}$/)
  phone_code!: string;

  @Matches(/^\d{6}$/)
  email_code!: string;
}
