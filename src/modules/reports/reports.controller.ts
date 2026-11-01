import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { TransactionTimeout } from '../../common/auth/transaction-timeout.decorator.js';
import { REPORT_TRANSACTION_TIMEOUT_MS } from '../../config/app.config.js';
import { MyDayQueryDto } from './dto/my-day-query.dto.js';
import { SalesReportQueryDto } from './dto/sales-report-query.dto.js';
import { ReportRateLimitGuard } from './report-rate-limit.guard.js';
import type { PaymentSplit, SalesSums } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

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

function paymentsJson(p: PaymentSplit) {
  return { cash: p.cash, mpesa_unverified: p.mpesaUnverified, mpesa_verified: p.mpesaVerified };
}
