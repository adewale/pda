import { workersConfig } from "./vitest.shared.ts";

/** The Workers suite: every test file except the durability suite (own runtime), the page tests (happy-dom), and the property tests and the fakes' contracts (Node: Hegel, and the fakes as the outbound service runs them). */
export default await workersConfig({
  name: "personal-agent",
  include: ["**/*.test.ts"],
  exclude: ["durability/**", "ui/**", "properties/**", "contracts/**"]
});
