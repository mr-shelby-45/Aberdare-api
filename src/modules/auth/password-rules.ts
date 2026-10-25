// Password rules beyond length (docs/phase-a-design.md section 10): the
// password must not equal the email, the phone (in any common form) or the
// email's local part. A common-password list is a later improvement.
export function passwordIsTooPersonal(password: string, phoneE164: string, email: string): boolean {
  const p = password.trim().toLowerCase();
  const localPart = email.split('@')[0];
  const phoneForms = [phoneE164, phoneE164.slice(1), `0${phoneE164.slice(4)}`];
  return p === email || p === localPart || phoneForms.includes(p);
}
