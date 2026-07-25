import { describe, expect, it } from "vitest";
import { loadAdaptationModelConfig } from "./model-config";

describe("adaptation model config", () => {
  it("uses the current low-latency DeepSeek model by default", () => {
    expect(loadAdaptationModelConfig({})).toEqual({
      apiBase: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
    });
  });

  it("accepts server-side endpoint and model overrides", () => {
    expect(
      loadAdaptationModelConfig({
        DEEPSEEK_API_BASE: "https://example.test/v1/",
        DEEPSEEK_MODEL: "deepseek-v4-pro",
      }),
    ).toEqual({
      apiBase: "https://example.test/v1",
      model: "deepseek-v4-pro",
    });
  });
});
