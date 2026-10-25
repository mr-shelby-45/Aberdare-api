import { IsIn, IsOptional } from 'class-validator';

export class ListLocationsQueryDto {
  // Query strings are text; no type coercion.
  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: 'true' | 'false';
}
