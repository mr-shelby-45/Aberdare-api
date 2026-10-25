import { IsString, Matches, MaxLength } from 'class-validator';

export class FirstLoginDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @Matches(/^\d{6}$/)
  temp_pin!: string;
}
