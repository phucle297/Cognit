#!/usr/bin/env node
/**
 * hooks/shared/ulid.mjs — zero-dependency Crockford-base32 ULID (26 chars).
 * Installed as ~/.cognit/hooks/ulid.mjs next to producer scripts.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const encodeTime = (now, len = 10) => {
  let t = now;
  let out = "";
  for (let i = len; i > 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod] + out;
    t = Math.floor(t / 32);
  }
  return out;
};

const encodeRandom = (len = 16) => {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i] & 31];
  return out;
};

export const ulid = () => encodeTime(Date.now()) + encodeRandom();

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.stdout.write(ulid());
}
