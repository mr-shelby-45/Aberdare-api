import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { CatalogueError } from '../catalogue.error.js';
import { CreateProductDto } from '../dto/create-product.dto.js';
import { ProductsService } from '../products.service.js';

// product.create (docs/phase-b-design.md section 5). Needs products.edit, and
// costs.view when any pack type carries a cost price.
@Injectable()
export class CreateProductHandler implements CommandHandler<CreateProductDto> {
  readonly type = 'product.create';
  readonly permission = 'products.edit';
  readonly payloadDto = CreateProductDto;

  constructor(private readonly products: ProductsService) {}

  extraPermissions(payload: CreateProductDto): string[] {
    return payload.pack_types.some((p) => p.cost_price !== undefined) ? ['costs.view'] : [];
  }

  async handle(payload: CreateProductDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      await this.products.createProduct(payload, ctx.actor.membershipId);
      return { status: 'ACCEPTED' };
    } catch (err) {
      if (err instanceof CatalogueError) throw new CommandRejectedError(err.code, err.message);
      throw err;
    }
  }
}
