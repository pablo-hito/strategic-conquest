/**
 * Branded identifiers. They are plain strings at runtime (cheap to serialize over
 * WebSocket) but the compiler refuses to mix a UnitId with a CityId.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PlayerId = Brand<string, 'PlayerId'>;
export type UnitId = Brand<string, 'UnitId'>;
export type CityId = Brand<string, 'CityId'>;

export const PlayerId = (v: string) => v as PlayerId;
export const UnitId = (v: string) => v as UnitId;
export const CityId = (v: string) => v as CityId;

/** Deterministic, monotonically increasing id factory (server-owned). */
export class IdSequence {
  constructor(private next = 1) {}
  unit(): UnitId {
    return UnitId(`u${this.next++}`);
  }
  city(): CityId {
    return CityId(`c${this.next++}`);
  }
  get cursor(): number {
    return this.next;
  }
}
