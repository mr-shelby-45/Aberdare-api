import { Injectable } from '@nestjs/common';
import { AddBarcodeHandler } from '../products/commands/add-barcode.handler.js';
import { CreateProductHandler } from '../products/commands/create-product.handler.js';
import { RemoveBarcodeHandler } from '../products/commands/remove-barcode.handler.js';
import { UpdateProductHandler } from '../products/commands/update-product.handler.js';
import { UpsertPackTypeHandler } from '../products/commands/upsert-pack-type.handler.js';
import type { CommandHandler } from './command-handler.js';

// The command types POST /v1/sync/commands accepts in Phase B: the five
// catalogue commands. The spike's stock handlers wait for Phase C (the spike
// step 3 test passes its own list).
@Injectable()
export class CatalogueHandlers {
  readonly all: readonly CommandHandler<object>[];

  constructor(
    createProduct: CreateProductHandler,
    updateProduct: UpdateProductHandler,
    upsertPackType: UpsertPackTypeHandler,
    addBarcode: AddBarcodeHandler,
    removeBarcode: RemoveBarcodeHandler,
  ) {
    this.all = [createProduct, updateProduct, upsertPackType, addBarcode, removeBarcode];
  }
}
