import { IsEmail, IsString, MaxLength } from 'class-validator';

export class SignupStartDto {
  // Kenyan mobile in any common form; normalised to E.164 by the service.
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;
}
