import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { CatalogueError } from '../catalogue.error.js';
import { UpdateProductDto } from '../dto/update-product.dto.js';
import { ProductsService } from '../products.service.js';

// product.update (docs/phase-b-design.md section 5): name, SKU, archive and
// restore. Needs products.edit.
@Injectable()
export class UpdateProductHandler implements CommandHandler<UpdateProductDto> {
  readonly type = 'product.update';
  readonly permission = 'products.edit';
  readonly payloadDto = UpdateProductDto;

  constructor(private readonly products: ProductsService) {}

  async handle(payload: UpdateProductDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      await this.products.updateProduct(payload, ctx.actor.membershipId);
      return { status: 'ACCEPTED' };
    } catch (err) {
      if (err instanceof CatalogueError) throw new CommandRejectedError(err.code, err.message);
      throw err;
    }
  }
}
