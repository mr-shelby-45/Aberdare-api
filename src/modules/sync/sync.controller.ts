import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { OwnTransactions } from '../../common/auth/own-transactions.decorator.js';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import type { CommandResult } from './command-outcome.js';
import { SyncBatchDto } from './dto/sync-batch.dto.js';
import { SyncService } from './sync.service.js';

// Phone commands (docs/phase-b-design.md section 5). Each command runs in its
// own tenant transaction, so this route opts out of the request transaction.
// Permissions are checked per command by SyncService.
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

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
