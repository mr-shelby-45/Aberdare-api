import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { APPROVAL_PURPOSES, type ApprovalPurpose } from '../approvals.repository.js';

// POST /v1/stock/approvals (docs/phase-c-design.md section 6). The PIN is
// only checked against the approver's hash; it is never stored or logged
// (the request log never has bodies, and "pin" keys are redacted).
export class CreateApprovalDto {
  @IsUUID()
  approver_membership_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  approver_pin!: string;

  // SALE_VOID since Phase E5.
  @IsIn(APPROVAL_PURPOSES)
  purpose!: ApprovalPurpose;
}
