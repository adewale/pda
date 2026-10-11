/**
 * What a run leaves on Docker, and the room it needs there (interop/README.md).
 * Every container, network and volume a run creates carries the label
 * `interop.run=<tag>`, its random tag, and the run removes exactly those on
 * exit, on error and on SIGINT or SIGTERM. Images are kept (runs reuse them),
 * build cache is never touched, and nothing without this run's label is.
 */

export const RUN_LABEL = "interop.run";

/** The image the free-space check runs `df` in: present after any build, and small. */
export const DISK_PROBE_IMAGE = "poppy-interop/proxy:latest";

export type Exec = (args: string[]) => string;

function filter(tag: string): string[] {
  // A tag that isn't the runner's own hex would widen the filter; refuse it.
  if (!/^[0-9a-f]{6,}$/.test(tag)) throw new Error(`Not a run tag: ${JSON.stringify(tag)}`);
  return ["--filter", `label=${RUN_LABEL}=${tag}`];
}

/** `docker create`, `run` and `network create` arguments that label a resource as this run's. */
export function labelArgs(tag: string): string[] {
  filter(tag);
  return ["--label", `${RUN_LABEL}=${tag}`];
}

const ids = (output: string) => output.split("\n").map((line) => line.trim()).filter(Boolean);

/**
 * Removes this run's containers (with their anonymous volumes), then its
 * networks and labelled volumes. Each step runs even if an earlier one
 * failed; what went wrong is returned, not thrown, so cleanup on the way out
 * never hides the error that caused it.
 */
export function removeRun(tag: string, exec: Exec): { removed: { containers: number; networks: number; volumes: number }; errors: string[] } {
  const by = filter(tag);
  const removed = { containers: 0, networks: 0, volumes: 0 };
  const errors: string[] = [];
  const step = (kind: keyof typeof removed, list: string[], remove: string[]) => {
    try {
      const found = ids(exec([...list, ...by]));
      if (found.length) exec([...remove, ...found]);
      removed[kind] = found.length;
    } catch (error) {
      errors.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  step("containers", ["ps", "-aq"], ["rm", "-f", "-v"]);
  step("networks", ["network", "ls", "-q"], ["network", "rm"]);
  step("volumes", ["volume", "ls", "-q"], ["volume", "rm", "-f"]);
  return { removed, errors };
}

/** The `Available` column of `df -Pk`'s last line, in KiB. */
export function parseDf(output: string): number {
  const last = output.trim().split("\n").at(-1) ?? "";
  const available = Number(last.trim().split(/\s+/)[3]);
  if (!Number.isFinite(available)) throw new Error(`Can't read df's output: ${JSON.stringify(output)}`);
  return available;
}

/**
 * Free space on Docker's data disk, from `df -Pk /` in a short-lived
 * container (its root is the overlay on that disk), or null when the probe
 * image isn't there yet (a first run builds it).
 */
export function dockerFreeGb(tag: string, exec: Exec, image = DISK_PROBE_IMAGE): number | null {
  try {
    exec(["image", "inspect", "--format", "{{.Id}}", image]);
  } catch {
    return null;
  }
  const output = exec(["run", "--rm", ...labelArgs(tag), "--network", "none", "--entrypoint", "df", image, "-Pk", "/"]);
  return parseDf(output) / (1024 * 1024);
}

/** Why a run mustn't start with this much free space, or null when it may. */
export function lowDisk(freeGb: number | null, minFreeGb: number): string | null {
  if (freeGb === null || freeGb >= minFreeGb) return null;
  return `Docker's data disk has ${freeGb.toFixed(1)} GB free, under the ${minFreeGb} GB a run needs (--min-free-gb). Free some space (images or build cache you no longer need) and run again; the runner removes nothing itself but its own containers, networks and volumes.`;
}
