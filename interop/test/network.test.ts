import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PORT,
  controlNetworkArgs,
  egressProbeArgs,
  egressRefusal,
  implementationCreateArgs,
  isolatedNetworkArgs,
  localNames,
  proxyCreateArgs,
  relayConnectArgs,
  relayCreateArgs
} from "../runner/network.ts";

const TAG = "a1b2c3";
const names = localNames(TAG);
const published = (args: readonly string[]) => args.some((arg) => arg === "-p" || arg === "--publish" || arg.startsWith("--publish=") || arg === "-P");
/** The value after each `--network` flag. */
const networksOf = (args: readonly string[]) => args.flatMap((arg, index) => (arg === "--network" ? [args[index + 1]] : []));

describe("the local lane's isolation", () => {
  it("creates the run's network with --internal, labelled as the run's", () => {
    const args = isolatedNetworkArgs(TAG);
    expect(args.slice(0, 2)).toEqual(["network", "create"]);
    expect(args).toContain("--internal");
    expect(args).toContain("interop.run=a1b2c3");
    expect(args.at(-1)).toBe("poppy-interop-a1b2c3");
  });

  it("puts the proxy and every implementation on the internal network only, publishing nothing", () => {
    const proxy = proxyCreateArgs(TAG, ["runner.interop.test", "x.company.interop.test"], "poppy-interop/proxy:latest");
    const impl = implementationCreateArgs(TAG, `${names.network}-company-x`, "company-x", { INTEROP_SECRET: "s" }, "poppy-interop/company-x:latest");
    for (const args of [proxy, impl]) {
      expect(networksOf(args)).toEqual([names.network]);
      expect(published(args)).toBe(false);
      expect(args).toContain("interop.run=a1b2c3");
    }
    expect(proxy).toEqual(expect.arrayContaining(["--network-alias", "x.company.interop.test"]));
    expect(impl).toEqual(expect.arrayContaining(["--network-alias", "company-x", "-e", "INTEROP_SECRET=s"]));
  });

  it("reaches the proxy's control port through a relay: the only container with a published port, to 127.0.0.1, forwarding to the proxy alone", () => {
    const relay = relayCreateArgs(TAG, "poppy-interop/proxy:latest");
    // Created on the ordinary control network (publishing needs one), then joined to the internal one.
    expect(networksOf(relay)).toEqual([names.controlNetwork]);
    expect(relay).toEqual(expect.arrayContaining(["-p", `127.0.0.1::${CONTROL_PORT}`]));
    expect(relay).toContain(`RELAY_TARGET=${names.proxy}:${CONTROL_PORT}`);
    expect(relay.slice(-2)).toEqual(["node", "/app/relay.mjs"]);
    expect(relayConnectArgs(TAG)).toEqual(["network", "connect", names.network, names.relay]);
    // The control network is an ordinary per-run bridge, labelled for cleanup.
    expect(controlNetworkArgs(TAG)).toEqual(["network", "create", "--label", "interop.run=a1b2c3", names.controlNetwork]);
  });

  it("ships the relay in the proxy image", () => {
    const dockerfile = readFileSync(path.join(import.meta.dirname, "../proxy/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY .*relay\.mjs/m);
  });

  it("probes egress from inside the network with docker exec", () => {
    const args = egressProbeArgs(names.proxy);
    expect(args.slice(0, 4)).toEqual(["exec", names.proxy, "node", "-e"]);
    expect(args[4]).toContain("1.1.1.1");
    expect(args[4]).toContain("example.com");
  });

  it("goes on only when every probe attempt failed", () => {
    expect(egressRefusal('{"tcp 1.1.1.1:443":"ENETUNREACH","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"EAI_AGAIN"}\n')).toBeNull();
    expect(egressRefusal('{"tcp 1.1.1.1:443":"timeout","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"ENOTFOUND"}')).toBeNull();
  });

  it("refuses the run when any attempt got out, naming it", () => {
    expect(egressRefusal('{"tcp 1.1.1.1:443":"connected","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"EAI_AGAIN"}')).toMatch(/reaches the internet \(tcp 1\.1\.1\.1:443: connected\)/);
    expect(egressRefusal('{"tcp 1.1.1.1:443":"ENETUNREACH","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"resolved 93.184.215.14"}')).toMatch(/dns example\.com: resolved/);
  });

  it("refuses the run when the probe gives no verdict: it proceeds only on proof", () => {
    expect(egressRefusal("")).toMatch(/no verdict/);
    expect(egressRefusal("sh: node: not found")).toMatch(/no verdict/);
    expect(egressRefusal("{}")).toMatch(/no verdict/);
    expect(egressRefusal('{"tcp 1.1.1.1:443":null}')).toMatch(/reaches the internet/);
  });

  it("has no setting that lifts --internal: the runner always creates the local network through isolatedNetworkArgs", () => {
    const cli = readFileSync(path.join(import.meta.dirname, "../runner/cli.ts"), "utf8");
    // Every `network create` the runner makes goes through network.ts; none is written inline.
    expect(cli).not.toMatch(/"network",\s*"create"/);
    expect(cli).toContain("docker(isolatedNetworkArgs(tag)");
    expect(cli).toContain("docker(egressProbeArgs(names.proxy)");
    expect(cli).toMatch(/if \(egress\) throw/);
    // And the probe runs before the first implementation's container is created.
    expect(cli.indexOf("docker(egressProbeArgs(names.proxy)")).toBeLessThan(cli.indexOf("implementationCreateArgs(tag"));
  });
});
