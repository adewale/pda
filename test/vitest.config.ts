import { workersConfig } from "./vitest.shared.ts";

/** The Workers suite: every test file except the durability suite (own runtime), the page tests (happy-dom) and the property tests (Node, for Hegel). */
export default await workersConfig({
  name: "personal-agent",
  include: ["**/*.test.ts"],
  exclude: ["durability/**", "ui/**", "properties/**"]
});
