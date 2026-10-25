import { IsEmail, MaxLength } from 'class-validator';

export class PasswordForgotDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
