import { describe, expect, it } from "vitest";
import { dockerFreeGb, labelArgs, lowDisk, parseDf, removeRun, RUN_LABEL } from "../runner/cleanup.ts";

/** A fake `docker`: answers listings from a table, records every call. */
function fakeDocker(listings: Record<string, string>, fail: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    if (fail(args)) throw new Error(`docker ${args[0]} failed`);
    return listings[args.slice(0, args.indexOf("--filter")).join(" ")] ?? "";
  };
  return { exec, calls };
}

describe("cleanup", () => {
  it("labels what a run makes with its tag, and refuses anything but a run tag", () => {
    expect(labelArgs("a1b2c3")).toEqual(["--label", `${RUN_LABEL}=a1b2c3`]);
    expect(() => labelArgs("")).toThrow("Not a run tag");
    expect(() => labelArgs("x y")).toThrow("Not a run tag");
  });

  it("removes only this run's containers, networks and volumes, by label, never images", () => {
    const { exec, calls } = fakeDocker({ "ps -aq": "c1\nc2\n", "network ls -q": "n1", "volume ls -q": "" });
    const { removed, errors } = removeRun("a1b2c3", exec);
    expect(removed).toEqual({ containers: 2, networks: 1, volumes: 0 });
    expect(errors).toEqual([]);
    // Every listing is filtered by this run's label.
    for (const call of calls.filter((args) => args.includes("-q"))) expect(call.slice(-2)).toEqual(["--filter", "label=interop.run=a1b2c3"]);
    expect(calls).toContainEqual(["rm", "-f", "-v", "c1", "c2"]);
    expect(calls).toContainEqual(["network", "rm", "n1"]);
    // Nothing to remove: no `volume rm`. And nothing touches images, the build cache, or prunes.
    expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(calls.some((args) => ["image", "rmi", "system", "builder", "buildx"].includes(args[0]!) || args.includes("prune"))).toBe(false);
  });

  it("keeps going when one step fails, and reports it", () => {
    const { exec, calls } = fakeDocker({ "ps -aq": "c1", "network ls -q": "n1" }, (args) => args[0] === "rm");
    const { removed, errors } = removeRun("a1b2c3", exec);
    expect(errors).toEqual([expect.stringContaining("containers")]);
    expect(removed.networks).toBe(1);
    expect(calls).toContainEqual(["network", "rm", "n1"]);
  });
});

describe("free disk", () => {
  const df = "Filesystem           1024-blocks    Used Available Capacity Mounted on\noverlay               81985944  75328960   2446400  97% /\n";

  it("reads df -Pk's Available column", () => {
    expect(parseDf(df)).toBe(2446400);
    expect(() => parseDf("nonsense")).toThrow("Can't read df");
  });

  it("measures Docker's disk in a labelled, networkless, short-lived container from an image already there", () => {
    const calls: string[][] = [];
    const free = dockerFreeGb("a1b2c3", (args) => {
      calls.push(args);
      return args[0] === "run" ? df : "sha256:x";
    });
    expect(free).toBeCloseTo(2446400 / 1024 / 1024, 5);
    expect(calls[1]).toEqual(["run", "--rm", "--label", "interop.run=a1b2c3", "--network", "none", "--entrypoint", "df", "poppy-interop/proxy:latest", "-Pk", "/"]);
    // No probe image yet (a first run builds it): no reading, rather than a pull.
    expect(
      dockerFreeGb("a1b2c3", () => {
        throw new Error("No such image");
      })
    ).toBeNull();
  });

  it("refuses to start below the threshold, with a clear message", () => {
    expect(lowDisk(2.33, 2)).toBeNull();
    expect(lowDisk(null, 2)).toBeNull();
    expect(lowDisk(1.5, 2)).toMatch(/1\.5 GB free, under the 2 GB a run needs \(--min-free-gb\)/);
    expect(lowDisk(0, 0)).toBeNull();
  });
});
