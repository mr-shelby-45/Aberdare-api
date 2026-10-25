import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

// product.update (docs/phase-b-design.md section 5). Omitted fields stay as
// they are; at least one must be sent (checked by ProductsService).
export class UpdateProductDto {
  @IsUUID()
  product_id!: string;

  // Present means a string: a product always has a name.
  @ValidateIf((o: UpdateProductDto) => o.name !== undefined)
  @IsString()
  @MaxLength(400)
  name?: string;

  // null clears the SKU.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sku?: string | null;

  @ValidateIf((o: UpdateProductDto) => o.archived !== undefined)
  @IsBoolean()
  archived?: boolean;
}
