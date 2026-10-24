import { IsString, Matches } from 'class-validator';

// Spike step 5 only: a body carrying values that must never be logged.
export class SpikeLoginDto {
  @Matches(/^\+254\d{9}$/)
  phone!: string;

  @Matches(/^\d{4}$/)
  pin!: string;

  @IsString()
  otp!: string;
}
