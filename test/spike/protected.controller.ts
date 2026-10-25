import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import type { AuthedRequest } from '../../src/common/auth/request-auth.js';
import { RequirePermission } from '../../src/common/auth/require-permission.decorator.js';
import { ProductsRepository } from '../../src/modules/products/products.repository.js';

export class ProtectedProductDto {
  @IsString()
  @Length(1, 60)
  name!: string;
}

// Phase A3 tests only: protected routes (no @Public) to exercise AuthGuard,
// TenantInterceptor and @RequirePermission. Lives under test/, never ships.
@Controller('spike/protected')
export class ProtectedController {
  private readonly products = new ProductsRepository();

  @Get('anyone')
  anyone(@Req() request: AuthedRequest) {
    return { membership_id: request.session?.membership.id, business_id: request.auth?.businessId };
  }

  // A manager permission.
  @Get('adjust')
  @RequirePermission('stock.adjust')
  adjust() {
    return { ok: true };
  }

  // An owner-only permission.
  @Get('staff')
  @RequirePermission('staff.manage')
  staff() {
    return { ok: true };
  }

  @Get('convert')
  @RequirePermission('stock.convert')
  convert() {
    return { ok: true };
  }

  // Reads and writes inside the request's tenant transaction.
  @Get('products')
  async list() {
    return (await this.products.list()).map((p) => ({ name: p.name, business_id: p.businessId }));
  }

  @Post('products')
  async create(@Body() dto: ProtectedProductDto) {
    const p = await this.products.create(dto.name);
    return { name: p.name, business_id: p.businessId };
  }
}
