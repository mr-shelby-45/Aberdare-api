import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export const LOCATION_KINDS = ['SHOP', 'WAREHOUSE', 'FIELD'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface LocationRow {
  id: string;
  name: string;
  isDefault: boolean;
  // Phase T: a FIELD location is assigned to one member; others to none.
  kind: string;
  assignedMembershipId: string | null;
  archivedAt: Date | null;
}

const SELECT = { id: true, name: true, isDefault: true, kind: true, assignedMembershipId: true, archivedAt: true } as const;

// location SQL. Every method runs on the current tenant transaction, so RLS
// limits it to the caller's business. app_user has no DELETE on location, and
// since T1 may update only name, archived_at and updated_at: a location's kind
// and assignee never change after creation.
@Injectable()
export class LocationsRepository {
  async create(location: { name: string; isDefault: boolean; kind?: LocationKind; assignedMembershipId?: string | null }): Promise<LocationRow> {
    return currentTx().location.create({
      data: { businessId: currentBusinessId(), ...location },
      select: SELECT,
    });
  }

  /** Default first, then by name. Only these ids when given (the location scope, Phase T2). */
  async list(includeArchived: boolean, onlyIds: string[] | null = null): Promise<LocationRow[]> {
    return currentTx().location.findMany({
      where: { ...(includeArchived ? {} : { archivedAt: null }), ...(onlyIds ? { id: { in: onlyIds } } : {}) },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      select: SELECT,
    });
  }

  async findById(id: string): Promise<LocationRow | null> {
    return currentTx().location.findUnique({ where: { id }, select: SELECT });
  }

  async rename(id: string, name: string): Promise<void> {
    await currentTx().location.update({ where: { id }, data: { name }, select: { id: true } });
  }

  /**
   * Archives a non-default location in one statement, only while another
   * active location remains. Returns false when that condition stopped it.
   */
  async archive(id: string, now: Date): Promise<boolean> {
    const count = await currentTx().$executeRaw`
      UPDATE location l
         SET archived_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
       WHERE l.id = ${id}::uuid
         AND l.business_id = ${currentBusinessId()}::uuid
         AND l.archived_at IS NULL
         AND NOT l.is_default
         AND EXISTS (SELECT 1 FROM location o
                      WHERE o.business_id = l.business_id AND o.id <> l.id AND o.archived_at IS NULL)`;
    return count === 1;
  }

  async restore(id: string): Promise<void> {
    await currentTx().location.update({ where: { id }, data: { archivedAt: null }, select: { id: true } });
  }

  /** Phase D2 snapshot: every location (or only these ids, Phase T2), archived too, keyset by id. */
  async pageForSync(afterId: string | null, limit: number, onlyIds: string[] | null = null): Promise<LocationRow[]> {
    return currentTx().location.findMany({
      where: { ...(afterId ? { id: { gt: afterId } } : {}), ...(onlyIds ? { id: { in: onlyIds, ...(afterId ? { gt: afterId } : {}) } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
      select: SELECT,
    });
  }

  /** Phase D3 changes: these locations as they are now (missing ids are simply absent). */
  async byIdsForSync(ids: string[]): Promise<LocationRow[]> {
    if (ids.length === 0) return [];
    return currentTx().location.findMany({ where: { id: { in: ids } }, select: SELECT });
  }

  /** Phase T2: every location assigned to this member, active or archived. */
  async assignedIds(membershipId: string): Promise<string[]> {
    const rows = await currentTx().location.findMany({ where: { assignedMembershipId: membershipId }, select: { id: true } });
    return rows.map((r) => r.id);
  }
}
