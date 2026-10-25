// Temp PINs (docs/phase-a-design.md sections 7 and 10): 6 random digits,
// valid 3 days, single use, killed by 5 wrong tries. Stored as an HMAC bound
// to the membership, so the same digits issued elsewhere never match.

export const TEMP_PIN_DAYS = 3;

/** The input to CodeHasher.hash for a temp PIN. */
export function tempPinHashInput(membershipId: string, tempPin: string) {
  return { channel: 'TEMP_PIN', target: membershipId, purpose: 'STAFF_ACTIVATE', code: tempPin };
}
