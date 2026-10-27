import { Controller, Get, Query, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ListMovementsQueryDto } from './dto/list-movements-query.dto.js';
import { ListStockQueryDto } from './dto/list-stock-query.dto.js';
import { StockReadsService } from './stock-reads.service.js';
import { balanceJson, movementJson } from './stock-view.js';

// Stock reads (docs/phase-c-design.md section 7). Any active member with
// stock.view (attendants have it); a field attendant sees only their own
// locations (Phase T2). No business parameter anywhere: RLS
// scopes every read to the caller's business. Stock writes are sync
// commands only. The request log records the route pattern, never the URL.
@Controller('v1/stock')
export class StockController {
  constructor(private readonly reads: StockReadsService) {}

  @Get()
  @RequirePermission('stock.view')
  async list(@Req() request: AuthedRequest, @Query() query: ListStockQueryDto) {
    const r = await this.reads.balances(query, request.session!.membership.id);
    return { balances: r.balances.map(balanceJson), next_cursor: r.nextCursor };
  }

  @Get('movements')
  @RequirePermission('stock.view')
  async movements(@Req() request: AuthedRequest, @Query() query: ListMovementsQueryDto) {
    const r = await this.reads.movements(query, request.session!.membership.id);
    const canSeeCosts = request.session!.permissions.has('costs.view');
    return { movements: r.movements.map((m) => movementJson(m, canSeeCosts)), next_cursor: r.nextCursor };
  }
}
