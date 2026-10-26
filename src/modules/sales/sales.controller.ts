import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { ListSalesQueryDto } from './dto/list-sales-query.dto.js';
import { SalesReadsService, type SalesViewer } from './sales-reads.service.js';
import { paymentJson, person, saleItemJson, saleJson, saleListJson } from './sales-view.js';

// Sales reads (docs/phase-e-design.md section 7). Any active member; who sees
// which sales is decided by sales.void (attendants see only their own). No
// business parameter anywhere: RLS scopes every read to the caller's
// business. Sales are written by sync commands only.
@Controller('v1/sales')
export class SalesController {
  constructor(private readonly reads: SalesReadsService) {}

  @Get()
  async list(@Req() request: AuthedRequest, @Query() query: ListSalesQueryDto) {
    const r = await this.reads.list(query, viewer(request));
    return { sales: r.sales.map((s) => saleListJson(s, r.names)), next_cursor: r.nextCursor };
  }

  @Get(':id')
  async byId(@Req() request: AuthedRequest, @Param('id') id: string) {
    const d = await this.reads.detail(id, viewer(request));
    const canSeeCosts = request.session!.permissions.has('costs.view');
    return {
      ...saleJson(d.sale),
      created_by: person(d.sale.createdByMembershipId, d.names),
      voided_by: person(d.sale.voidedByMembershipId, d.names),
      void_approved_by: person(d.sale.voidApprovedByMembershipId, d.names),
      items: d.items.map((i) => saleItemJson(i, canSeeCosts)),
      payments: d.payments.map(paymentJson),
    };
  }
}

function viewer(request: AuthedRequest): SalesViewer {
  return { membershipId: request.session!.membership.id, allSales: request.session!.permissions.has('sales.void') };
}
