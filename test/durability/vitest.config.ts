import { workersConfig } from "../vitest.shared.ts";

/**
 * Tests that crash every Durable Object. They get a workerd runtime of their
 * own: in the shared one, `abortAllDurableObjects()` also reset the mock
 * Companies other files were using, which made Poppy tests flaky.
 */
export default await workersConfig({ name: "durability", include: ["durability/**/*.test.ts"] });
