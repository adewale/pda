# Official Company validator cross-check

`npm run interop:official` runs the unmodified, pinned official Company validator against our 0.2 mock. It reuses the harness's internal network, recording proxy, CA, identity hosting and cleanup. All upstream code executes inside Docker; the validator has no internet route. Its private test key exists only in its temporary container.

This is a one-sided check, not a new M×N implementation. The provisioning harness's placeholder cell is unsupported because the validator advertises no interop scenarios. The actual evidence is `official-validator.json`, which names every official check, pass, failure and skip. The script fails when the validator fails or never runs. Official negative checks deliberately send invalid assertions and proofs: their success is the Company refusing them, not a clean trace of an ordinary agent.

The upstream README documents its limits: sign-in and Operations checks are unavailable in this snapshot. Cross-checks supplement the independent Python client, Datalayer cases and the interop grid; agreement is not certification.
