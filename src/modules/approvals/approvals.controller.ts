import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { OwnTransactions } from '../../common/auth/own-transactions.decorator.js';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { AUTH_ROUTE_RATE_LIMIT } from '../../common/http/auth-rate-limit.js';
import { ApprovalsService } from './approvals.service.js';
import { CreateApprovalDto } from './dto/create-approval.dto.js';

// Approvals (docs/phase-c-design.md section 6). Any active member with
// stock.view may ask. The request log records the route pattern only and
// never bodies, so the approver's PIN never reaches a log.
@Controller('v1/stock')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('approvers')
  @RequirePermission('stock.view')
  async approvers(@Req() request: AuthedRequest) {
    const list = await this.approvals.listApprovers(request.session!.membership.id);
    return { approvers: list.map((a) => ({ membership_id: a.membershipId, display_name: a.displayName, role_preset: a.rolePreset })) };
  }

  // Outside the request transaction (decided in C5), so the PIN is checked
  // outside any transaction; same per-IP limit as the auth routes.
  @Post('approvals')
  @HttpCode(201)
  @OwnTransactions()
  @RequirePermission('stock.view')
  @RouteConfig(AUTH_ROUTE_RATE_LIMIT)
  async create(@Req() request: AuthedRequest, @Body() dto: CreateApprovalDto) {
    const session = request.session!;
    const r = await this.approvals.mint(
      { businessId: request.auth!.businessId, membershipId: session.membership.id, deviceId: request.auth!.deviceId, permissions: session.permissions },
      dto,
    );
    return { approval_id: r.approvalId, valid_until: r.validUntil.toISOString() };
  }
}
