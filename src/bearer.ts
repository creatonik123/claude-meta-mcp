import crypto from "node:crypto";

/**
 * True only when the Authorization header carries exactly the expected Bearer token.
 *
 * A plain string compare stops at the first differing character, so response timing leaks how much
 * of a guess was right. timingSafeEqual takes the same time for any content of a given length; it
 * throws on unequal lengths, so a length mismatch is refused before it is called.
 */
export function bearerTokenMatches(header: string, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const presented = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (presented.length !== wanted.length) return false;
  return crypto.timingSafeEqual(presented, wanted);
}
