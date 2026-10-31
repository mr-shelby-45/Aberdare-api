import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsOptional, IsUUID } from 'class-validator';

// POST /v1/notifications/read: { ids: [...] } (1 to 100) or { all: true },
// exactly one (checked by the service).
export class MarkReadDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @Equals(true)
  all?: true;
}
