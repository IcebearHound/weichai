import { describe, expect, it } from "vitest";
import { translationVerifierSchemaVersion } from "./index";

describe("translation-verifier entry", () => {
  it("exposes the schema version constant", () => {
    expect(translationVerifierSchemaVersion).toBe("1.0");
  });
});
