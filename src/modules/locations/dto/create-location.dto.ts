import { IsString, MaxLength } from 'class-validator';

export class CreateLocationDto {
  // 1 to 60 characters after trimming (checked by the service).
  @IsString()
  @MaxLength(200)
  name!: string;
}
