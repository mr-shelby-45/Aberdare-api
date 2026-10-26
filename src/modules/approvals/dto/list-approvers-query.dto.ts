import { IsIn, IsOptional } from 'class-validator';
import { APPROVAL_PURPOSES, type ApprovalPurpose } from '../approvals.repository.js';

// GET /v1/stock/approvers (docs/phase-e-design.md section 6): who could
// approve this purpose. Without purpose, STOCK_CONVERT (the C5 behaviour).
export class ListApproversQueryDto {
  @IsOptional()
  @IsIn(APPROVAL_PURPOSES)
  purpose?: ApprovalPurpose;
}
