import { IsUUID } from 'class-validator';

export class AddDeviceMemberDto {
  @IsUUID()
  membership_id!: string;
}
