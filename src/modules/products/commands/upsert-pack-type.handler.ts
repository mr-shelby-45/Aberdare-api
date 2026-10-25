import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { CatalogueError } from '../catalogue.error.js';
import { UpsertPackTypeDto } from '../dto/upsert-pack-type.dto.js';
import { ProductsService } from '../products.service.js';

// pack_type.upsert (docs/phase-b-design.md section 5). Needs products.edit,
// and costs.view when cost_price is sent (a value or null to clear it).
@Injectable()
export class UpsertPackTypeHandler implements CommandHandler<UpsertPackTypeDto> {
  readonly type = 'pack_type.upsert';
  readonly permission = 'products.edit';
  readonly payloadDto = UpsertPackTypeDto;

  constructor(private readonly products: ProductsService) {}

  extraPermissions(payload: UpsertPackTypeDto): string[] {
    return payload.cost_price !== undefined ? ['costs.view'] : [];
  }

  async handle(payload: UpsertPackTypeDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      await this.products.upsertPackType(payload, ctx.actor.membershipId);
      return { status: 'ACCEPTED' };
    } catch (err) {
      if (err instanceof CatalogueError) throw new CommandRejectedError(err.code, err.message);
      throw err;
    }
  }
}
