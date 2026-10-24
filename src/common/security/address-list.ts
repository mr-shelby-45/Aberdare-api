import { BlockList, isIP } from 'node:net';

// IP addresses and CIDR ranges ("10.0.0.0/8", "192.0.2.7", "2001:db8::/32"),
// matched with Node's built-in BlockList (no library needed).

/** True for a single IPv4/IPv6 address or a CIDR range with a valid prefix. */
export function isAddressOrRange(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address);
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

/** Builds a matcher. Entries must already be validated with isAddressOrRange. */
export function toBlockList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

/** Whether ip is in the list. IPv4-mapped IPv6 ("::ffff:192.0.2.7") is checked as IPv4. */
export function listContains(list: BlockList, ip: string): boolean {
  const plain = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(plain);
  if (family === 0) return false;
  return list.check(plain, family === 6 ? 'ipv6' : 'ipv4');
}
