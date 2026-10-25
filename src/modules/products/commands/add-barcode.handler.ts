import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { CatalogueError } from '../catalogue.error.js';
import { AddBarcodeDto } from '../dto/add-barcode.dto.js';
import { ProductsService } from '../products.service.js';

// barcode.add (docs/phase-b-design.md section 5). Needs products.edit. The
// same code on the same pack type again is an accepted no-op.
@Injectable()
export class AddBarcodeHandler implements CommandHandler<AddBarcodeDto> {
  readonly type = 'barcode.add';
  readonly permission = 'products.edit';
  readonly payloadDto = AddBarcodeDto;

  constructor(private readonly products: ProductsService) {}

  async handle(payload: AddBarcodeDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      await this.products.addBarcode(payload, ctx.actor.membershipId);
      return { status: 'ACCEPTED' };
    } catch (err) {
      if (err instanceof CatalogueError) throw new CommandRejectedError(err.code, err.message);
      throw err;
    }
  }
}
