/**
 * The control relay (interop spec section 3, Isolation). The run's network is
 * `--internal`, so nothing on it can publish a port; this runs in a second
 * container of the proxy image that joins both the internal network and an
 * ordinary per-run one, publishes RELAY_PORT on 127.0.0.1, and pipes each
 * connection to one fixed address, RELAY_TARGET (the proxy's control port).
 * It forwards nowhere else, so it gives nothing on the internal network a way out.
 *
 * No dependencies: Node's own net.
 */
import net from "node:net";

const listenPort = Number(process.env.RELAY_PORT ?? "8082");
const target = /^([a-z0-9.-]+):(\d+)$/i.exec(process.env.RELAY_TARGET ?? "");
if (!target) {
  console.error(`relay: RELAY_TARGET must be host:port, not ${JSON.stringify(process.env.RELAY_TARGET)}`);
  process.exit(1);
}
const [, host, port] = target;

net
  .createServer((client) => {
    const upstream = net.connect({ host, port: Number(port) });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.pipe(upstream);
    upstream.pipe(client);
  })
  .listen(listenPort, () => console.log(`relay: ${listenPort} -> ${host}:${port}`));
