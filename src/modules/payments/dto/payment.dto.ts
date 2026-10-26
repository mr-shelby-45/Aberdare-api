import { IsOptional, IsString, MaxLength } from 'class-validator';

// One payment from the phone (docs/phase-e-design.md section 5). Only the
// shape is checked here; a bad method, amount or code is reported per
// payment by PaymentsService (INVALID_PAYMENTS), so the phone sees every bad
// payment at once.
export class PaymentDto {
  @IsString()
  @MaxLength(20)
  method!: string;

  // KES as a string; its format is a payment check.
  @IsString()
  @MaxLength(40)
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  mpesa_code?: string | null;
}
