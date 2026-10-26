import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { OwnTransactions } from '../../common/auth/own-transactions.decorator.js';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import type { CommandResult } from './command-outcome.js';
import { ChangesService } from './changes.service.js';
import { ChangesQueryDto } from './dto/changes-query.dto.js';
import { SnapshotQueryDto } from './dto/snapshot-query.dto.js';
import { SyncBatchDto } from './dto/sync-batch.dto.js';
import { SnapshotService } from './snapshot.service.js';
import { SyncService } from './sync.service.js';

// Phone commands (docs/phase-b-design.md section 5). Each command runs in its
// own tenant transaction, so this route opts out of the request transaction.
// Permissions are checked per command by SyncService.
@Controller('v1/sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly snapshots: SnapshotService,
    private readonly changeFeed: ChangesService,
  ) {}

  @Post('commands')
  @HttpCode(200)
  @OwnTransactions()
  async commands(@Req() request: AuthedRequest, @Body() dto: SyncBatchDto) {
    const session = request.session!;
    const results = await this.sync.processCommands(
      { businessId: request.auth!.businessId, membershipId: session.membership.id, deviceId: request.auth!.deviceId, permissions: session.permissions },
      dto.commands,
    );
    for (const r of results) {
      if (r.failure) {
        // Ids and types only: payloads hold prices, names and barcodes.
        request.log.error(
          { commandId: r.commandId, commandType: r.failure.type, errorName: r.failure.errorName, errorCode: r.failure.errorCode },
          'sync command failed',
        );
      }
    }
    return { results: results.map(toJson) };
  }

  // The offline download (docs/phase-d-design.md section 5). Any active member
  // on an active device (the pipeline loads both live); runs in the request's
  // own short tenant transaction like any read. The request log has the route
  // pattern only, never the cursor.
  @Get('snapshot')
  async snapshot(@Req() request: AuthedRequest, @Query() query: SnapshotQueryDto) {
    const p = await this.snapshots.page(query, {
      businessId: request.auth!.businessId,
      membershipId: request.session!.membership.id,
      deviceId: request.auth!.deviceId,
      permissions: request.session!.permissions,
    });
    return {
      table: p.table,
      rows: p.rows,
      next_cursor: p.nextCursor,
      next_table: p.nextTable,
      ...(p.startCursor !== undefined ? { start_cursor: p.startCursor } : {}),
    };
  }

  // What changed since the phone's cursor (docs/phase-d-design.md section 6).
  // Same pipeline and transaction rules as the snapshot.
  @Get('changes')
  async changes(@Req() request: AuthedRequest, @Query() query: ChangesQueryDto) {
    const r = await this.changeFeed.changes(query, {
      businessId: request.auth!.businessId,
      membershipId: request.session!.membership.id,
      deviceId: request.auth!.deviceId,
      permissions: request.session!.permissions,
    });
    return { changes: r.changes, next_cursor: r.nextCursor, has_more: r.hasMore };
  }
}

function toJson(r: CommandResult) {
  return {
    command_id: r.commandId,
    status: r.status,
    ...(r.code !== undefined ? { reason: r.code } : {}),
    ...(r.message !== undefined ? { message: r.message } : {}),
    ...(r.data !== undefined ? { result: r.data } : {}),
  };
}
