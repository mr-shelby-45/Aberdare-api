import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const VOID_REASONS = ['MISTAKE', 'CUSTOMER_CANCELLED', 'WRONG_PRICE', 'OTHER'] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

// sale.void (docs/phase-e-design.md section 5): the whole sale. approval_id
// is used only by a member without sales.void.
export class VoidSaleDto {
  @IsUUID()
  sale_id!: string;

  @IsIn(VOID_REASONS)
  reason!: VoidReason;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  @IsOptional()
  @IsUUID()
  approval_id?: string;
}
