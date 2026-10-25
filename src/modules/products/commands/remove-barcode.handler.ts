import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { CatalogueError } from '../catalogue.error.js';
import { RemoveBarcodeDto } from '../dto/remove-barcode.dto.js';
import { ProductsService } from '../products.service.js';

// barcode.remove (docs/phase-b-design.md section 5). Needs products.edit.
// Removing a code that does not exist is an accepted no-op.
@Injectable()
export class RemoveBarcodeHandler implements CommandHandler<RemoveBarcodeDto> {
  readonly type = 'barcode.remove';
  readonly permission = 'products.edit';
  readonly payloadDto = RemoveBarcodeDto;

  constructor(private readonly products: ProductsService) {}

  async handle(payload: RemoveBarcodeDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      await this.products.removeBarcode(payload, ctx.actor.membershipId);
      return { status: 'ACCEPTED' };
    } catch (err) {
      if (err instanceof CatalogueError) throw new CommandRejectedError(err.code, err.message);
      throw err;
    }
  }
}
