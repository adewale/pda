# PR 36: sufficiency review of 0.3 verification

The [assessment](../../poppy-0.3-conformance.md#is-the-03-verification-sufficient) separates current local checks from independent and live evidence. It lists six remaining priorities; it does not mark them completed.

The fresh independent Python run found a shared assumption in the existing message oracle. It removed `context`, as the mock did before the official kit corrected that behavior. The oracle now compares the entire sent message, with the Company-assigned role. Empty context, availability and locale/time-zone cases pass; dropped or changed context fails. Generators, default example/step counts and other invariants are preserved.

- `python-oracle-before.txt`: the three new focused cases fail with the preceding oracle. This is a test of the oracle, without a Company process.
- `python-current.txt`: the complete independent Python suite passes, **21 tests in 93.74 seconds**, after the correction. The five state machines use the default 100 examples and up to 30 steps. This also exercises the current mock through the Python client's own wire implementation.
- `validation.json`: source and receipt hashes, commands, profile and limitations. PDA/Company runtime source is unchanged from `2a369f589e03398e31208022aae235a2ed07260c`; only the Python oracle/tests and documentation change in this review.

Reproduce with the pinned Python dependencies and Node:

```sh
npm run test:hypothesis
```

`UV_CACHE_DIR` in the receipt points at a writable temporary cache for this managed environment. It does not change dependencies or test settings. Terminal color codes and trailing empty lines are removed from the text receipts for reading.

The Python suite remains an occasional local check, as documented in its README. It tests the Company fixture, not PDA's production client, and shares our documented interpretations of the specification. It supplies no live identity, hosted OAuth, external payment or real-model evidence.
