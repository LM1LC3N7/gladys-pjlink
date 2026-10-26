// -----------------------------------------------------------------------------
// A refused password is remembered across restarts without being kept: only
// a salted SHA-256 of it cut to 6 bits (one value among 64) is written in
// /data, so that a restart can tell a changed password (try it) from the
// same one (do not send it again). 6 bits identify nothing: 1 in 64 of any
// list of candidates shares a mark (about 156 of the 10 000 four-digit codes,
// test/authmark.test.js). The mark
// is erased once a password is accepted; the good one never has a mark.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

export const MARK_BITS = 6;

export const newSalt = () => randomBytes(16).toString('hex');

/** The mark of `password` under `salt`: an integer from 0 to 63. */
export function markOf(salt, password) {
  const hash = createHash('sha256')
    .update(`${salt}:${password ?? ''}`, 'utf8')
    .digest();
  return hash[0] >> (8 - MARK_BITS);
}
