/**
 * Client entry point: types and the patch helpers, without the zod schemas the
 * server uses to validate input (keeps the browser bundle small).
 */
export * from './view.js';
export type { Command, RoomSettings } from './messages.js';
