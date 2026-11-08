import { randomBytes } from 'node:crypto';
import { UnitId } from '@sc/core';

/**
 * Per-player opaque unit ids. Real ids are sequential, so seeing "u812" would tell a
 * rival how many units were ever built. Each player instead sees random ids that
 * are stable for the whole game (and saved with it).
 */
export class IdMask {
  private readonly out = new Map<string, string>();
  private readonly back = new Map<string, string>();

  constructor(entries: readonly [string, string][] = []) {
    for (const [real, opaque] of entries) {
      this.out.set(real, opaque);
      this.back.set(opaque, real);
    }
  }

  toOpaque(real: string): UnitId {
    let o = this.out.get(real);
    if (!o) {
      do o = `k${randomBytes(5).toString('hex')}`;
      while (this.back.has(o));
      this.out.set(real, o);
      this.back.set(o, real);
    }
    return UnitId(o);
  }

  /** Undefined for ids this player was never shown (they can't refer to them). */
  toReal(opaque: string): UnitId | undefined {
    const r = this.back.get(opaque);
    return r === undefined ? undefined : UnitId(r);
  }

  entries(): [string, string][] {
    return [...this.out];
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

export function roomCode(): string {
  const bytes = randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function newToken(): string {
  return randomBytes(24).toString('hex');
}
