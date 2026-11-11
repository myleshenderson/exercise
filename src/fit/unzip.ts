import { unzipSync } from "fflate";
import { FitError } from "./errors";

/** Largest .fit entry inflated (64 MiB); a long 1 Hz ride is a few MiB. */
export const MAX_FIT_BYTES = 64 * 1024 * 1024;

function isFitEntry(name: string): boolean {
  const base = name.split("/").pop() ?? "";
  return base.toLowerCase().endsWith(".fit") && !base.startsWith("._") && !name.startsWith("__MACOSX/");
}

/**
 * Garmin's `/download-service/files/activity/{id}` returns a ZIP holding one
 * `{activityId}_ACTIVITY.fit` entry. Return that entry's bytes. Only `.fit`
 * entries are inflated (macOS `__MACOSX/` and `._` resource forks are
 * ignored), and an entry declaring more than `maxBytes` (default `MAX_FIT_BYTES`) is refused.
 */
export function fitFromZip(bytes: Uint8Array, maxBytes = MAX_FIT_BYTES): Uint8Array {
  const names: string[] = [];
  let tooLarge: string | null = null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (!isFitEntry(f.name)) return false;
        names.push(f.name);
        if (f.originalSize > maxBytes) {
          tooLarge = f.name;
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    throw new FitError(`not a readable ZIP: ${(err as Error).message}`);
  }
  if (names.length !== 1) {
    throw new FitError(`expected exactly one .fit entry in the ZIP, found ${names.length}`);
  }
  if (tooLarge) throw new FitError(`${tooLarge} is larger than ${maxBytes} bytes`);
  const fit = entries[names[0]];
  if (fit.length > maxBytes) throw new FitError(`${names[0]} is larger than ${maxBytes} bytes`);
  return fit;
}
