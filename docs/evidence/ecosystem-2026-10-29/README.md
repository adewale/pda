# Ecosystem evidence — 29 October 2026

`discovery.json` is the public discovery check behind [the ecosystem page's 29 October section](../../ecosystem.md#current-ecosystem): the 28 October survey's 33 hosts, each checked once with `node scripts/poppy-validate.ts --json <host>` under the validator's 0.3 profile, one host at a time and two seconds apart, through the session's proxy with TLS verification. For each host it keeps the time, the declared version, the outcome, the message ids and texts, and each document's URL, status and a SHA-256 of its parsed JSON. The documents themselves aren't kept.

It establishes what each host's documents said and how our validator judged them that day. It doesn't establish that a host works with any agent: no Session, sign-in or order was attempted.
