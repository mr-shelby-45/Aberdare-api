import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Turns untrusted input into a validated DTO instance, or null if it is not a
 * plain object or breaks any rule. Unknown properties are rejected, and values
 * are not coerced (the string "5" is not a number).
 */
export async function validateDto<T extends object>(
  dto: new () => T,
  input: unknown,
): Promise<T | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const instance = plainToInstance(dto, input);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  return errors.length === 0 ? instance : null;
}
