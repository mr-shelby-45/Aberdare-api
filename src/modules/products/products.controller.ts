import { Controller, Get, Param, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { productJson } from './product-view.js';
import { ProductsService } from './products.service.js';

// Catalogue reads (docs/phase-b-design.md section 6). Any active member may
// read; there is no business parameter anywhere (RLS scopes every read to the
// caller's business). Catalogue writes are sync commands only.
@Controller('v1/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  // The log line records the route pattern, never the code itself.
  @Get('by-barcode/:code')
  async byBarcode(@Req() request: AuthedRequest, @Param('code') code: string) {
    const found = await this.products.findByBarcode(code);
    const canSeeCosts = request.session!.permissions.has('costs.view');
    return { pack_type_id: found.packTypeId, product: productJson(found.product, canSeeCosts) };
  }
}
