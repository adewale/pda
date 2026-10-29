/** Shared private-file boundary for the hosted preparation and evidence commands. */
import { AssertionError } from "node:assert";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";

export class PrivateInputError extends Error {}

export function readPrivateJson(file) {
  let contents;
  try {
    if ((statSync(file).mode & 0o077) !== 0) throw new PrivateInputError("Private JSON files must have permissions 0600");
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof PrivateInputError) throw error;
    throw new PrivateInputError("Could not read a private JSON file");
  }
  try { return JSON.parse(contents); }
  catch { throw new PrivateInputError("A private file is not valid JSON"); }
}

export function writePrivateJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Only our supplied messages are printable; parser/network errors can contain private inputs. */
export function privateErrorMessage(error, fallback) {
  return error instanceof PrivateInputError || (error instanceof AssertionError && !error.generatedMessage)
    ? error.message.split(/\r?\n/, 1)[0] : fallback;
}
