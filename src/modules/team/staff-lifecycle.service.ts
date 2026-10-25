import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CodeHasher } from '../../common/auth/code-hasher.js';
import type { RequestSession } from '../../common/auth/request-auth.js';
import { randomDigits } from '../../common/auth/secrets.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { maskPhone, normalizeKenyanPhone } from '../../common/validation/contact.js';
import { IdentityLookup } from '../../database/identity-lookup.js';
import { type AuditMetadata, AuditService } from '../audit/audit.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { RefreshTokensService } from '../sessions/refresh-tokens.service.js';
import { StaffService } from '../staff/staff.service.js';
import { TEMP_PIN_DAYS, tempPinHashInput } from '../staff/temp-pin.js';
import type { CreateStaffDto } from './dto/create-staff.dto.js';
import type { UpdateStaffDto } from './dto/update-staff.dto.js';
import { checkExtraPermissions, notFound, ownerProtected, refuseSelf } from './staff-rules.js';

// The staff endpoints (docs/phase-a-design.md section 11). Runs inside the
// request's tenant transaction (TenantInterceptor), so every change, its
// token revocations, its device changes and its audit row commit together.
@Injectable()
export class StaffLifecycleService {
  constructor(
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly identity: IdentityLookup,
    private readonly codes: CodeHasher,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Invites a manager or attendant. The temp PIN is returned once and stored hashed. */
  async create(actor: RequestSession, dto: CreateStaffDto) {
    const phone = normalizeKenyanPhone(dto.phone);
    if (!phone) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: phone');
    const extras = dto.extra_permissions ?? [];
    checkExtraPermissions(dto.role_preset, extras, actor);

    const now = this.clock.now();
    const { personId } = await this.identity.ensurePerson(phone, now);
    const tempPin = randomDigits(6);
    const tempPinExpiresAt = new Date(now.getTime() + TEMP_PIN_DAYS * 86_400_000);

    const existing = await this.staff.findByPerson(personId);
    let membershipId: string;
    if (existing) {
      if (existing.status !== 'REMOVED') {
        throw new ApiError(409, 'MEMBER_EXISTS', 'This person is already on your staff.');
      }
      membershipId = existing.id;
      await this.staff.reinvite(membershipId, {
        displayName: dto.display_name,
        rolePreset: dto.role_preset,
        extraPermissions: extras,
        tempPinHash: this.codes.hash(tempPinHashInput(membershipId, tempPin)),
        tempPinExpiresAt,
      });
    } else {
      membershipId = randomUUID();
      await this.staff.createInvite({
        id: membershipId,
        personId,
        displayName: dto.display_name,
        rolePreset: dto.role_preset,
        extraPermissions: extras,
        tempPinHash: this.codes.hash(tempPinHashInput(membershipId, tempPin)),
        tempPinExpiresAt,
        createdByMembershipId: actor.membership.id,
      });
    }
    await this.audit.record({
      action: 'staff.created',
      targetType: 'membership',
      targetId: membershipId,
      metadata: { role_preset: dto.role_preset, extra_permissions: extras, reinvited: existing !== null },
    });
    return { membershipId, tempPin, tempPinExpiresAt };
  }

  /** Never any hash; phones masked to their last 3 digits. */
  async list() {
    const rows = await this.staff.list();
    return rows.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      role_preset: m.rolePreset,
      status: m.status,
      extra_permissions: m.extraPermissions ?? [],
      phone: maskPhone(m.person.phone),
      created_at: m.createdAt.toISOString(),
    }));
  }

  async update(actor: RequestSession, id: string, dto: UpdateStaffDto): Promise<void> {
    const target = await this.staff.findById(id);
    if (!target) throw notFound();
    const changesAccess = dto.role_preset !== undefined || dto.extra_permissions !== undefined;
    if (changesAccess) {
      refuseSelf(id, actor);
      if (target.rolePreset === 'OWNER') throw ownerProtected();
      const preset = dto.role_preset ?? (target.rolePreset as 'MANAGER' | 'ATTENDANT');
      // Check the resulting combination, so a demotion cannot keep stock.convert.
      checkExtraPermissions(preset, dto.extra_permissions ?? target.extraPermissions ?? [], actor);
    }
    await this.staff.update(id, {
      displayName: dto.display_name,
      rolePreset: dto.role_preset,
      extraPermissions: dto.extra_permissions,
    });
    const changed = [
      ...(dto.display_name !== undefined ? ['display_name'] : []),
      ...(dto.role_preset !== undefined ? ['role_preset'] : []),
      ...(dto.extra_permissions !== undefined ? ['extra_permissions'] : []),
    ];
    const metadata: AuditMetadata = { changed };
    if (dto.role_preset !== undefined) metadata.role_preset = dto.role_preset;
    if (dto.extra_permissions !== undefined) metadata.extra_permissions = dto.extra_permissions;
    await this.audit.record({ action: 'staff.updated', targetType: 'membership', targetId: id, metadata });
  }

  /** New temp PIN, back to INVITED; tokens, tablet links and the person's phones are revoked. */
  async resetPin(actor: RequestSession, id: string) {
    const target = await this.guardTarget(actor, id);
    const now = this.clock.now();
    const tempPin = randomDigits(6);
    const tempPinExpiresAt = new Date(now.getTime() + TEMP_PIN_DAYS * 86_400_000);
    await this.staff.resetToInvite(target.id, this.codes.hash(tempPinHashInput(target.id, tempPin)), tempPinExpiresAt);
    await this.cutAccess(target.id, now);
    await this.audit.record({ action: 'staff.pin_reset', targetType: 'membership', targetId: target.id });
    return { membershipId: target.id, tempPin, tempPinExpiresAt };
  }

  async suspend(actor: RequestSession, id: string): Promise<void> {
    const target = await this.guardTarget(actor, id);
    if (!(await this.staff.setStatus(target.id, ['ACTIVE'], 'SUSPENDED'))) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Only active staff can be suspended.');
    }
    await this.refreshTokens.revokeForMembership(target.id, this.clock.now());
    await this.audit.record({ action: 'staff.suspended', targetType: 'membership', targetId: target.id });
  }

  async reactivate(actor: RequestSession, id: string): Promise<void> {
    const target = await this.guardTarget(actor, id);
    if (!(await this.staff.setStatus(target.id, ['SUSPENDED'], 'ACTIVE'))) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Only suspended staff can be reactivated.');
    }
    await this.audit.record({ action: 'staff.reactivated', targetType: 'membership', targetId: target.id });
  }

  /** Status REMOVED, never a hard delete. */
  async remove(actor: RequestSession, id: string): Promise<void> {
    const target = await this.guardTarget(actor, id);
    if (!(await this.staff.setStatus(target.id, ['INVITED', 'ACTIVE', 'SUSPENDED'], 'REMOVED'))) {
      throw notFound();
    }
    await this.cutAccess(target.id, this.clock.now());
    await this.audit.record({ action: 'staff.removed', targetType: 'membership', targetId: target.id });
  }

  private async guardTarget(actor: RequestSession, id: string) {
    const target = await this.staff.findById(id);
    if (!target) throw notFound();
    refuseSelf(id, actor);
    if (target.rolePreset === 'OWNER') throw ownerProtected();
    return target;
  }

  /** Every way back in: refresh tokens, shared-tablet links, and the phones the person registered. */
  private async cutAccess(membershipId: string, now: Date): Promise<void> {
    await this.refreshTokens.revokeForMembership(membershipId, now);
    await this.devices.removeLinksForMembership(membershipId);
    for (const deviceId of await this.devices.revokeRegisteredBy(membershipId)) {
      await this.refreshTokens.revokeForDevice(deviceId, now);
    }
  }
}
