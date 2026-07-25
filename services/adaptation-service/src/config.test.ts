import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("adaptation config loader", () => {
  it("reads all config values with defaults", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4001);
    expect(config.corsOrigin).toBe("http://localhost:4173");
    expect(config.deepseekApiKey).toBe("sk-test");
    expect(config.skeletonProjectPath).toBeUndefined();
    expect(config.projectRoot).toBeUndefined();
  });

  it("reads optional paths when provided", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_SKELETON_PATH: "/tmp/skeleton",
      ADAPTATION_PROJECT_ROOT: "/tmp/project",
    });

    expect(config.skeletonProjectPath).toBe("/tmp/skeleton");
    expect(config.projectRoot).toBe("/tmp/project");
  });

  it("reads custom host and port", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_HOST: "0.0.0.0",
      ADAPTATION_PORT: "9090",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9090);
  });

  it("reads custom CORS origin", () => {
    const config = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      ADAPTATION_CORS_ORIGIN: "https://example.com",
    });

    expect(config.corsOrigin).toBe("https://example.com");
  });

  it("throws when DEEPSEEK_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow("DEEPSEEK_API_KEY is required.");
  });

  it("throws for invalid port values", () => {
    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", ADAPTATION_PORT: "0" }),
    ).toThrow("ADAPTATION_PORT must be a positive integer.");

    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", ADAPTATION_PORT: "-1" }),
    ).toThrow("ADAPTATION_PORT must be a positive integer.");

    expect(() =>
      loadConfig({ DEEPSEEK_API_KEY: "sk-test", ADAPTATION_PORT: "abc" }),
    ).toThrow("ADAPTATION_PORT must be a positive integer.");
  });
});
