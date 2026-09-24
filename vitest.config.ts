import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "sidecar/**/*.test.ts", "dev/**/*.test.ts"],
    environment: "node",
  },
});
