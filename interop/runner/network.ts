/**
 * The local lane's network (interop spec section 3, Isolation). Every
 * implementation and the recording proxy sit on one `--internal` network: no
 * route out, and Docker's resolver answers only the run's own names. Nothing
 * on it can publish a port, so the runner reaches the proxy's control port
 * through a relay, a container of the proxy image running `relay.mjs`, which
 * joins the internal network and a second, ordinary per-run network that
 * publishes only the relay's port on 127.0.0.1. The relay forwards that port
 * to one fixed address, the proxy's control port, and nothing else; adapters'
 * control calls go on through the proxy's `/control`, as before. The relay is
 * the only container with a port or a way out, and it runs our code.
 *
 * Nothing here takes an option that lifts `--internal`: the live lane, which
 * needs the internet by definition, creates no network at all (cli.ts).
 */
import { labelArgs } from "./cleanup.ts";

/** The proxy's control port, which the relay forwards and publishes. */
export const CONTROL_PORT = 8082;

/** The run's networks and the containers that tie them together. */
export function localNames(tag: string) {
  const network = `poppy-interop-${tag}`;
  return {
    /** The internal network every implementation and the proxy are on. */
    network,
    /** The ordinary network only the relay joins, to publish its port. */
    controlNetwork: `${network}-control`,
    proxy: `${network}-proxy`,
    relay: `${network}-relay`
  };
}

/** `docker network create` for the internal network. Always `--internal`. */
export function isolatedNetworkArgs(tag: string): string[] {
  return ["network", "create", "--internal", ...labelArgs(tag), localNames(tag).network];
}

/** `docker network create` for the relay's published side: an ordinary bridge only the relay joins. */
export function controlNetworkArgs(tag: string): string[] {
  return ["network", "create", ...labelArgs(tag), localNames(tag).controlNetwork];
}

/** `docker create` for the proxy: on the internal network only, with every name it answers for, no published port. */
export function proxyCreateArgs(tag: string, aliases: readonly string[], image: string): string[] {
  const names = localNames(tag);
  return ["create", "--name", names.proxy, ...labelArgs(tag), "--network", names.network, ...aliases.flatMap((alias) => ["--network-alias", alias]), image];
}

/**
 * `docker create` for the relay: on the control network with its port
 * published to 127.0.0.1 (then connected to the internal network, see
 * `relayConnectArgs`), forwarding to the proxy's control port only.
 */
export function relayCreateArgs(tag: string, image: string): string[] {
  const names = localNames(tag);
  return [
    "create",
    "--name",
    names.relay,
    ...labelArgs(tag),
    "--network",
    names.controlNetwork,
    "-p",
    `127.0.0.1::${CONTROL_PORT}`,
    "-e",
    `RELAY_PORT=${CONTROL_PORT}`,
    "-e",
    `RELAY_TARGET=${names.proxy}:${CONTROL_PORT}`,
    image,
    "node",
    "/app/relay.mjs"
  ];
}

/** `docker network connect`: the relay's second leg, on the internal network, to reach the proxy. */
export function relayConnectArgs(tag: string): string[] {
  const names = localNames(tag);
  return ["network", "connect", names.network, names.relay];
}

/** `docker create` for an implementation: on the internal network only, with no published port. */
export function implementationCreateArgs(tag: string, name: string, alias: string, env: Readonly<Record<string, string>>, image: string): string[] {
  return [
    "create",
    "--name",
    name,
    ...labelArgs(tag),
    "--network",
    localNames(tag).network,
    "--network-alias",
    alias,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image
  ];
}

/** What `network inspect` must say before anything runs on the network. */
export const INTERNAL_FORMAT = "{{.Internal}}";

/**
 * The egress probe: a Node script run with `docker exec` in the proxy, which
 * is on the internal network only, as every implementation is. It tries a
 * TCP connection to two public addresses and a DNS lookup of a public name,
 * and prints one JSON line, each attempt's outcome: `connected`, `resolved
 * <address>`, or the error (`ENETUNREACH`, `EAI_AGAIN`, `timeout`...).
 */
export const EGRESS_PROBE = `
const net = require("node:net");
const dns = require("node:dns");
const tcp = (host, port) => new Promise((done) => {
  const socket = net.connect({ host, port, timeout: 4000 });
  socket.on("connect", () => { socket.destroy(); done("connected"); });
  socket.on("timeout", () => { socket.destroy(); done("timeout"); });
  socket.on("error", (error) => done(error.code || error.message));
});
const lookup = (name) => dns.promises.lookup(name).then((found) => "resolved " + found.address, (error) => error.code || error.message);
Promise.all([tcp("1.1.1.1", 443), tcp("8.8.8.8", 53), lookup("example.com")]).then(([a, b, c]) =>
  console.log(JSON.stringify({ "tcp 1.1.1.1:443": a, "tcp 8.8.8.8:53": b, "dns example.com": c })));
`;

/** `docker exec` for the egress probe in a container on the internal network. */
export function egressProbeArgs(container: string): string[] {
  return ["exec", container, "node", "-e", EGRESS_PROBE];
}

/**
 * The probe's verdict: null when every attempt failed (no egress), or why the
 * run must not go on. Output that isn't the probe's JSON is a refusal too:
 * the run proceeds only on proof.
 */
export function egressRefusal(output: string): string | null {
  let attempts: Record<string, unknown>;
  try {
    attempts = JSON.parse(output.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  } catch {
    return `the egress probe printed no verdict: ${JSON.stringify(output.slice(0, 200))}`;
  }
  if (attempts === null || typeof attempts !== "object" || Object.keys(attempts).length === 0) {
    return `the egress probe printed no verdict: ${JSON.stringify(output.slice(0, 200))}`;
  }
  const reached = Object.entries(attempts).filter(([, outcome]) => typeof outcome !== "string" || outcome === "connected" || outcome.startsWith("resolved"));
  if (reached.length === 0) return null;
  return `the run's network reaches the internet (${reached.map(([attempt, outcome]) => `${attempt}: ${String(outcome)}`).join(", ")}); refusing to run implementations on it`;
}
