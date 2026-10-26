import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID, ValidateNested } from 'class-validator';
import { PaymentDto } from '../../payments/dto/payment.dto.js';

// payment.attach (docs/phase-e-design.md section 5): 1 to 10 payments for one sale.
export class AttachPaymentDto {
  @IsUUID()
  sale_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PaymentDto)
  payments!: PaymentDto[];
}
