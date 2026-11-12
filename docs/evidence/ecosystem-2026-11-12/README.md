# Ecosystem evidence — 12 November 2026

Behind [the ecosystem page's 12 November section](../../ecosystem.md#current-ecosystem), taken the day PDA was first deployed speaking Poppy 0.4 alone.

- `discovery.json`: 58 hosts, each checked once with `node scripts/poppy-validate.ts --json <host>` at `c79324a` (the 0.4 profile, the only one it has), one host at a time and two seconds apart, over direct HTTPS with TLS verification. The hosts are the 29 October list's 33, PAP Checker's directory (39) and Company hosts named on poppy.md's implementations page; `sources` records each list's SHA-256 and `listed_in` where each host came from. For each host it keeps the time, the declared version, `supported_versions` where present, the outcome, the message ids and texts, and each document's URL, status and a SHA-256 of its parsed JSON. The documents themselves aren't kept.
- `repositories.json`: 42 repositories read at their default-branch heads through the GitHub API and shallow clones, read as files. No third-party code was run. Print with Poppy was re-read after its PR #36 merged at 19:45 UTC.

It establishes what each host's documents said, how our validator judged them, and what each repository's code and documentation said that day. It doesn't establish that a host works with any agent: no Session, sign-in or order was attempted, and nothing was posted to any project.
