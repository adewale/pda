import { workersConfig } from "../vitest.shared.ts";

/**
 * Whole-runtime crash tests stay in their own project as an isolation policy.
 * File workers currently have separate runtimes; retain this boundary if
 * file-worker pooling changes.
 */
export default await workersConfig({ name: "durability", include: ["durability/**/*.test.ts"] });
