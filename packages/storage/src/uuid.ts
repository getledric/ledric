import { v7 as uuidv7 } from 'uuid';

export function uuidv7Bytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  uuidv7(undefined, bytes);
  return bytes;
}
