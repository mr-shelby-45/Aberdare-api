import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import type { SettlementLineRow, SettlementRow } from '../field-settlements/field-settlements.repository.js';
import { ListSettlementsQueryDto, PreviewQueryDto } from './dto/settlement-queries.dto.js';
import { FieldService } from './field.service.js';

// Field settlements (docs/phase-t-design.md section 6): online reads for
// managers and owners (field.settle). The close itself is the
// settlement.close sync command. Money as strings, times as UTC ISO text.
@Controller('v1/field/settlements')
export class FieldController {
  constructor(private readonly field: FieldService) {}

  @Get('preview')
  @RequirePermission('field.settle')
  async preview(@Query() query: PreviewQueryDto) {
    const p = await this.field.preview(query.location_id);
    return {
      location_id: p.location.id,
      attendant_membership_id: p.location.assignedMembershipId,
      period_start: p.periodStart ? p.periodStart.toISOString() : null,
      last_synced_at: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
      lines: p.figures.lines.map((l) => ({
        pack_type_id: l.packTypeId,
        issued: l.issued,
        returned: l.returned,
        sold: l.sold,
        voided_back: l.voidedBack,
        other: l.other,
        expected_quantity: l.expectedQuantity,
      })),
      expected_cash: p.figures.expectedCash,
      mpesa_verified_total: p.figures.mpesaVerifiedTotal,
      mpesa_unverified_total: p.figures.mpesaUnverifiedTotal,
      sale_count: p.figures.saleCount,
      voided_count: p.figures.voidedCount,
      unpaid_total: p.figures.unpaidTotal,
    };
  }

  @Get()
  @RequirePermission('field.settle')
  async list(@Query() query: ListSettlementsQueryDto) {
    const r = await this.field.list(query);
    return { settlements: r.settlements.map(settlementJson), next_cursor: r.nextCursor };
  }

  @Get(':id')
  @RequirePermission('field.settle')
  async byId(@Param('id') id: string) {
    const d = await this.field.detail(id);
    return { ...settlementJson(d.settlement), lines: d.lines.map(lineJson) };
  }
}

function settlementJson(s: SettlementRow) {
  return {
    id: s.id,
    field_location_id: s.fieldLocationId,
    attendant_membership_id: s.attendantMembershipId,
    closed_by_membership_id: s.closedByMembershipId,
    occurred_at: s.occurredAt.toISOString(),
    period_start: s.periodStart.toISOString(),
    period_end: s.periodEnd.toISOString(),
    expected_cash: s.expectedCash,
    cash_received: s.cashReceived,
    cash_variance: s.cashVariance,
    mpesa_verified_total: s.mpesaVerifiedTotal,
    mpesa_unverified_total: s.mpesaUnverifiedTotal,
    sale_count: s.saleCount,
    voided_count: s.voidedCount,
    unpaid_total: s.unpaidTotal,
    note: s.note,
  };
}

function lineJson(l: SettlementLineRow) {
  return {
    pack_type_id: l.packTypeId,
    issued: l.issued,
    returned: l.returned,
    sold: l.sold,
    voided_back: l.voidedBack,
    expected_quantity: l.expectedQuantity,
    counted_quantity: l.countedQuantity,
    variance: l.variance,
  };
}
