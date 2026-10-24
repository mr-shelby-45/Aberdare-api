import { IsInt, IsUUID, Max, Min } from 'class-validator';

// Payload of stock.receive and stock.adjust: a whole number of packs of one
// pack type at one location (CLAUDE.md rule 8).
export class StockQuantityChangeDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  packTypeId!: string;

  // Upper bound keeps the value inside a Postgres integer with room to spare.
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;
}
