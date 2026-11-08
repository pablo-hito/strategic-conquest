import { z } from 'zod';
import { CITY_SPECIALIZATIONS, UNIT_TYPE_IDS } from '@sc/core';

import { PROTOCOL_VERSION } from './view.js';

export { PROTOCOL_VERSION };

/** Largest message the server accepts (a long move path is the biggest legit one). */
export const MAX_MESSAGE_BYTES = 16 * 1024;

const coord = z.object({ x: z.number().int().min(0).max(1000), y: z.number().int().min(0).max(1000) });
const id = z.string().min(1).max(40);

export const roomSettingsSchema = z.object({
  players: z.number().int().min(2).max(6),
  size: z.union([
    z.enum(['small', 'medium', 'huge']),
    z.object({ width: z.number().int().min(30).max(200), height: z.number().int().min(20).max(120) }),
  ]),
  density: z.enum(['sparse', 'normal', 'dense']),
  /** Production bonus for computer seats. */
  difficulty: z.enum(['normal', 'hard', 'brutal']),
  /** Seconds per turn; 0 = no clock. */
  turnSeconds: z.number().int().min(0).max(3600),
  /** Seats nobody took when the host starts are played by bots. */
  fillWithBots: z.boolean(),
  seed: z.string().max(60).optional(),
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const commandSchema = z.discriminatedUnion('c', [
  z.object({ c: z.literal('move'), unit: id, path: z.array(coord).min(1).max(300) }),
  z.object({ c: z.literal('attack'), unit: id, target: coord }),
  z.object({ c: z.literal('production'), city: id, unitType: z.enum(UNIT_TYPE_IDS) }),
  z.object({ c: z.literal('specialize'), city: id, spec: z.enum(CITY_SPECIALIZATIONS) }),
  z.object({ c: z.literal('silent'), unit: id, on: z.boolean() }),
  z.object({ c: z.literal('board'), unit: id, carrier: id }),
  z.object({ c: z.literal('disband'), unit: id }),
  z.object({ c: z.literal('endTurn') }),
]);
export type Command = z.infer<typeof commandSchema>;

export const clientMessageSchema = z.discriminatedUnion('t', [
  /** First message. `resume` reclaims a seat after a disconnect. */
  z.object({
    t: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    name: z.string().trim().min(1).max(24),
    resume: z.object({ room: z.string().max(12), token: z.string().max(80) }).optional(),
  }),
  z.object({ t: z.literal('create'), settings: roomSettingsSchema }),
  z.object({ t: z.literal('join'), room: z.string().trim().min(4).max(12) }),
  z.object({ t: z.literal('ready'), ready: z.boolean() }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('leave') }),
  z.object({ t: z.literal('cmd'), id: z.number().int().min(0), cmd: commandSchema }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Parse an incoming client frame; never throws. */
export function parseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'message too large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const r = clientMessageSchema.safeParse(data);
  return r.success ? { ok: true, msg: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid message' };
}
