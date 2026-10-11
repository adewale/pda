import { workersConfig } from "./vitest.shared.ts";

/** The Workers suite: every test file except the durability suite (own runtime) and the page tests (happy-dom). */
export default await workersConfig({
  name: "personal-agent",
  include: ["**/*.test.ts"],
  exclude: ["durability/**", "ui/**"]
});
