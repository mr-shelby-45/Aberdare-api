import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { TransactionTimeout } from '../../common/auth/transaction-timeout.decorator.js';
import { REPORT_TRANSACTION_TIMEOUT_MS } from '../../config/app.config.js';
import { MyDayQueryDto } from './dto/my-day-query.dto.js';
import { ProfitQueryDto } from './dto/profit-query.dto.js';
import { SalesReportQueryDto } from './dto/sales-report-query.dto.js';
import { ShrinkageQueryDto } from './dto/shrinkage-query.dto.js';
import { StockReportQueryDto } from './dto/stock-report-query.dto.js';
import { TopProductsQueryDto } from './dto/top-products-query.dto.js';
import { ReportRateLimitGuard } from './report-rate-limit.guard.js';
import type { PaymentSplit, ProfitSums, SalesSums } from './reports.repository.js';
import { type ShrinkageFigures, type StockFigures, ReportsService } from './reports.service.js';

// Reports (Phase G1, docs/phase-g1-design.md section 5). Online only, never
// synced. Each route: the per-member report limit (the guard), a 10 second
// tenant transaction (the 8 second statement timeout fires inside it), and
// its permission checked by TenantInterceptor on the live membership.
@Controller('v1/reports')
@UseGuards(ReportRateLimitGuard)
@TransactionTimeout(REPORT_TRANSACTION_TIMEOUT_MS)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermission('reports.view')
  async sales(@Query() query: SalesReportQueryDto) {
    const r = await this.reports.sales(query);
    return {
      range: { from: r.range.from, to: r.range.to },
      group_by: r.groupBy,
      totals: sumsJson(r.totals),
      rows: r.rows.map((row) => ({
        ...(r.groupBy === 'day'
          ? { date: row.key }
          : r.groupBy === 'attendant'
            ? { attendant: { membership_id: row.key, display_name: r.names.get(row.key) ?? null } }
            : { location: { id: row.key, name: row.locationName } }),
        ...sumsJson(row),
      })),
      payments: paymentsJson(r.payments),
    };
  }

  // Cost keys (cost, profit, value_without_cost) only with costs.view; absent otherwise.
  @Get('top-products')
  @RequirePermission('reports.view')
  async topProducts(@Req() request: AuthedRequest, @Query() query: TopProductsQueryDto) {
    const r = await this.reports.topProducts(query, request.session!.permissions.has('costs.view'));
    return {
      range: { from: r.range.from, to: r.range.to },
      by: r.by,
      rows: r.rows.map((row) => ({
        product: { id: row.productId, name: row.name },
        pieces: row.pieces,
        value: row.value,
        ...(row.costs
          ? { cost: row.costs.cost, profit: row.costs.profit, value_without_cost: row.costs.valueWithoutCost }
          : {}),
      })),
    };
  }

  // Refused (403) without costs.view: every figure here is a cost figure.
  @Get('profit')
  @RequirePermission('reports.view', 'costs.view')
  async profit(@Query() query: ProfitQueryDto) {
    const r = await this.reports.profit(query);
    return {
      range: { from: r.range.from, to: r.range.to },
      group_by: r.groupBy,
      totals: { revenue: r.totals.revenue, cost: r.totals.cost, profit: r.totals.profit },
      lines_without_cost: r.totals.linesWithoutCost,
      revenue_without_cost: r.totals.revenueWithoutCost,
      rows: r.rows.map((row) => ({
        ...(r.groupBy === 'day'
          ? { date: row.key }
          : r.groupBy === 'attendant'
            ? { attendant: { membership_id: row.key, display_name: r.names.get(row.key) ?? null } }
            : { product: { id: row.key, name: row.productName } }),
        ...profitJson(row),
      })),
    };
  }

  // Stock on hand now. value_at_cost and pools_without_cost only with costs.view.
  @Get('stock')
  @RequirePermission('reports.view')
  async stock(@Req() request: AuthedRequest, @Query() query: StockReportQueryDto) {
    const r = await this.reports.stock(query, request.session!.permissions.has('costs.view'));
    return {
      group_by: r.groupBy,
      totals: stockJson(r.totals),
      rows: r.rows.map((row) =>
        r.groupBy === 'product'
          ? {
              product: { id: row.key, name: row.name },
              ...stockJson(row),
              packs: row.packs.map((p) => ({
                pack_type: { id: p.packTypeId, name: p.name, units_per_pack: p.unitsPerPack },
                quantity: p.quantity,
              })),
            }
          : { location: { id: row.key, name: row.name }, ...stockJson(row) },
      ),
    };
  }

  // Always in pieces. The value figures only with costs.view.
  @Get('shrinkage')
  @RequirePermission('reports.view')
  async shrinkage(@Req() request: AuthedRequest, @Query() query: ShrinkageQueryDto) {
    const r = await this.reports.shrinkage(query, request.session!.permissions.has('costs.view'));
    return {
      range: { from: r.range.from, to: r.range.to },
      group_by: r.groupBy,
      unit: 'pieces',
      totals: shrinkageJson(r.totals),
      rows: r.rows.map((row) => ({
        ...(r.groupBy === 'reason'
          ? { reason: row.key }
          : r.groupBy === 'person'
            ? { person: { membership_id: row.key, display_name: r.names.get(row.key) ?? null } }
            : r.groupBy === 'location'
              ? { location: { id: row.key, name: row.name } }
              : { product: { id: row.key, name: row.name } }),
        ...shrinkageJson(row),
      })),
    };
  }

  // Attendants and field attendants too: only the caller's own sales, no costs.
  @Get('my-day')
  @RequirePermission('sales.create')
  async myDay(@Req() request: AuthedRequest, @Query() query: MyDayQueryDto) {
    const r = await this.reports.myDay(request.session!.membership.id, query);
    return { date: r.date, ...sumsJson(r.totals), voided_count: r.voidedCount, payments: paymentsJson(r.payments) };
  }
}

function sumsJson(s: SalesSums) {
  return { sale_count: s.saleCount, total: s.total, paid_total: s.paidTotal, balance_due: s.balanceDue };
}

function profitJson(p: ProfitSums) {
  return {
    revenue: p.revenue,
    cost: p.cost,
    profit: p.profit,
    lines_without_cost: p.linesWithoutCost,
    revenue_without_cost: p.revenueWithoutCost,
  };
}

function stockJson(s: StockFigures) {
  return {
    pieces: s.pieces,
    pools: s.pools,
    negative_pools: s.negativePools,
    ...(s.costs ? { value_at_cost: s.costs.valueAtCost, pools_without_cost: s.costs.poolsWithoutCost } : {}),
  };
}

function shrinkageJson(s: ShrinkageFigures) {
  return {
    units_lost: s.unitsLost,
    units_found: s.unitsFound,
    net_units: s.netUnits,
    ...(s.costs
      ? {
          value_lost_at_cost: s.costs.valueLostAtCost,
          value_found_at_cost: s.costs.valueFoundAtCost,
          net_value_at_cost: s.costs.netValueAtCost,
          movements_without_cost: s.costs.movementsWithoutCost,
        }
      : {}),
  };
}

function paymentsJson(p: PaymentSplit) {
  return { cash: p.cash, mpesa_unverified: p.mpesaUnverified, mpesa_verified: p.mpesaVerified };
}
