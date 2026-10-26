import { Injectable } from '@nestjs/common';
import { AddBarcodeHandler } from '../products/commands/add-barcode.handler.js';
import { CreateProductHandler } from '../products/commands/create-product.handler.js';
import { RemoveBarcodeHandler } from '../products/commands/remove-barcode.handler.js';
import { UpdateProductHandler } from '../products/commands/update-product.handler.js';
import { UpsertPackTypeHandler } from '../products/commands/upsert-pack-type.handler.js';
import { CreateSaleHandler } from '../sales/commands/create-sale.handler.js';
import { AdjustStockHandler } from '../stock/commands/adjust-stock.handler.js';
import { ConvertStockHandler } from '../stock/commands/convert-stock.handler.js';
import { CountStockHandler } from '../stock/commands/count-stock.handler.js';
import { ReceiveStockHandler } from '../stock/commands/receive-stock.handler.js';
import type { CommandHandler } from './command-handler.js';

// The command types POST /v1/sync/commands accepts: the five catalogue
// commands (Phase B) and the stock commands built so far (Phase C2: receive
// and adjust; C3: count; C4: convert) and the sale commands (Phase E2: sale.create).
@Injectable()
export class CommandHandlers {
  readonly all: readonly CommandHandler<object>[];

  constructor(
    createProduct: CreateProductHandler,
    updateProduct: UpdateProductHandler,
    upsertPackType: UpsertPackTypeHandler,
    addBarcode: AddBarcodeHandler,
    removeBarcode: RemoveBarcodeHandler,
    receiveStock: ReceiveStockHandler,
    adjustStock: AdjustStockHandler,
    countStock: CountStockHandler,
    convertStock: ConvertStockHandler,
    createSale: CreateSaleHandler,
  ) {
    this.all = [createProduct, updateProduct, upsertPackType, addBarcode, removeBarcode, receiveStock, adjustStock, countStock, convertStock, createSale];
  }
}
