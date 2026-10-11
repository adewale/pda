import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library cleans up by itself only when Vitest's globals are on.
afterEach(() => cleanup());
