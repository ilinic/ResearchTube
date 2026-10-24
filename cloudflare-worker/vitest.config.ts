import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.mjs"], pool: "threads", maxWorkers: 1, testTimeout: 30_000, hookTimeout: 30_000 } });
