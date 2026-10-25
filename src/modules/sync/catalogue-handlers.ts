import { Injectable } from '@nestjs/common';
import { CreateProductHandler } from '../products/commands/create-product.handler.js';
import { UpdateProductHandler } from '../products/commands/update-product.handler.js';
import { UpsertPackTypeHandler } from '../products/commands/upsert-pack-type.handler.js';
import type { CommandHandler } from './command-handler.js';

// The command types POST /v1/sync/commands accepts in Phase B. barcode.add and
// barcode.remove join in B3; the spike's stock handlers wait for Phase C (the
// spike step 3 test passes its own list).
@Injectable()
export class CatalogueHandlers {
  readonly all: readonly CommandHandler<object>[];

  constructor(createProduct: CreateProductHandler, updateProduct: UpdateProductHandler, upsertPackType: UpsertPackTypeHandler) {
    this.all = [createProduct, updateProduct, upsertPackType];
  }
}
