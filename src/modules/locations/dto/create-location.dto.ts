import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { LOCATION_KINDS, type LocationKind } from '../locations.repository.js';

export class CreateLocationDto {
  // 1 to 60 characters after trimming (checked by the service).
  @IsString()
  @MaxLength(200)
  name!: string;

  // Phase T: SHOP when left out.
  @IsOptional()
  @IsIn(LOCATION_KINDS)
  kind?: LocationKind;

  // Phase T: required exactly for a FIELD location, a FIELD_ATTENDANT of this business.
  @IsOptional()
  @IsUUID()
  assigned_membership_id?: string;
}
