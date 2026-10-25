import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { ListProductsQueryDto } from './dto/list-products-query.dto.js';
import { productJson } from './product-view.js';
import { ProductsService } from './products.service.js';

// Catalogue reads (docs/phase-b-design.md section 6). Any active member may
// read; there is no business parameter anywhere (RLS scopes every read to the
// caller's business). Catalogue writes are sync commands only. The request
// log records the route pattern, never the URL, so search text and codes
// stay out of the logs.
@Controller('v1/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async list(@Req() request: AuthedRequest, @Query() query: ListProductsQueryDto) {
    const r = await this.products.listOrSearch(query);
    const canSeeCosts = canSee(request);
    return {
      products: r.products.map((p) => productJson(p, canSeeCosts)),
      // A listing has pages; a search has none, so no next_cursor key at all.
      ...(r.nextCursor !== undefined ? { next_cursor: r.nextCursor } : {}),
    };
  }

  // Declared before :id. Fastify prefers the static segment anyway.
  @Get('by-barcode/:code')
  async byBarcode(@Req() request: AuthedRequest, @Param('code') code: string) {
    const found = await this.products.findByBarcode(code);
    return { pack_type_id: found.packTypeId, product: productJson(found.product, canSee(request)) };
  }

  @Get(':id')
  async byId(@Req() request: AuthedRequest, @Param('id') id: string) {
    return productJson(await this.products.findById(id), canSee(request));
  }
}

function canSee(request: AuthedRequest): boolean {
  return request.session!.permissions.has('costs.view');
}
