/**
 * The run's private CA and the proxy's certificate (spec section 3), made
 * with the `openssl` CLI. A new CA per run, so nothing outside the run can
 * be fooled by it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The names the proxy's certificate covers. TLS wildcards match one label,
 * so each Company gets its own `*.<name>.company.interop.test` beside
 * `*.company.interop.test`.
 */
export function certificateNames(companies: readonly string[]): string[] {
  return [
    "*.company.interop.test",
    ...companies.map((name) => `*.${name}.company.interop.test`),
    "*.agent.interop.test",
    "runner.interop.test"
  ];
}

function openssl(args: string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

/** Writes ca.pem, ca.key, proxy.pem and proxy.key into `dir`. */
export function makeCertificates(dir: string, run: string, companies: readonly string[]): { ca: string; dir: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "ca.cnf"),
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ca",
      "prompt = no",
      "[dn]",
      `CN = Poppy interop CA ${run}`,
      "[ca]",
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash"
    ].join("\n")
  );
  writeFileSync(
    path.join(dir, "proxy.cnf"),
    [
      "basicConstraints = CA:FALSE",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = serverAuth",
      "authorityKeyIdentifier = keyid",
      `subjectAltName = ${certificateNames(companies).map((name) => `DNS:${name}`).join(", ")}`
    ].join("\n")
  );
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"], dir);
  openssl(["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "3", "-config", "ca.cnf", "-out", "ca.pem"], dir);
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "proxy.key"], dir);
  openssl(["req", "-new", "-key", "proxy.key", "-subj", "/CN=interop.test", "-out", "proxy.csr"], dir);
  openssl(
    ["x509", "-req", "-in", "proxy.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "3", "-sha256", "-extfile", "proxy.cnf", "-out", "proxy.pem"],
    dir
  );
  return { ca: path.join(dir, "ca.pem"), dir };
}
