// One list for the full local/CI run and standalone documentation discovery.
// Targeted commands remain independent; only a full run can supply all names.
export const testConfigs = [
  "test/vitest.config.ts",
  "test/durability/vitest.config.ts",
  "test/ui/vitest.config.ts",
  "interop/vitest.config.ts",
  "test/properties/vitest.config.ts"
];
