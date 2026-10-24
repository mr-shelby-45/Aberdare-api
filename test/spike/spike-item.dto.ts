import { IsInt, IsString, Min, MinLength } from 'class-validator';

// Spike step 5 only: a body to validate.
export class SpikeItemDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}
