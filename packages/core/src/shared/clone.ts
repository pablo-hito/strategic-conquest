/**
 * Deep copy for entity state. All domain state is JSON-safe by design (it is what
 * goes over the wire), so this works identically in Node and the browser without
 * depending on DOM or Node typings.
 */
export const cloneState = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
