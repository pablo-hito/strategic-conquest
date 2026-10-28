/**
 * Player commands are validated server-side (anti-cheat). Rule violations are
 * expected outcomes, not exceptions, so they travel as Result values with a stable
 * error code the client can localize. Exceptions are reserved for broken invariants.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E extends string = string> = {
  readonly ok: false;
  readonly error: { readonly code: E; readonly message: string };
};
export type Result<T, E extends string = string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E extends string>(code: E, message: string): Err<E> => ({
  ok: false,
  error: { code, message },
});

export class InvariantError extends Error {
  override name = 'InvariantError';
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
