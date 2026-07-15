import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadGateAnswers,
  rememberedGateDigit,
  saveGateAnswer,
} from "../src/services/questions/codexGateAnswers";

let configDirBefore: string | undefined;
let testConfigDir: string;
beforeEach(() => {
  configDirBefore = process.env.THREADBASE_CONFIG_DIR;
  testConfigDir = mkdtempSync(join(tmpdir(), "tb-gate-answers-"));
  process.env.THREADBASE_CONFIG_DIR = testConfigDir;
});
afterEach(() => {
  if (configDirBefore === undefined) delete process.env.THREADBASE_CONFIG_DIR;
  else process.env.THREADBASE_CONFIG_DIR = configDirBefore;
});

function answersPath(): string {
  return join(testConfigDir, "gate-answers.json");
}

describe("codexGateAnswers store", () => {
  it("returns {} when the file is missing", () => {
    expect(loadGateAnswers()).toEqual({});
  });

  it("returns {} for corrupt or non-object content", () => {
    writeFileSync(answersPath(), "{not json");
    expect(loadGateAnswers()).toEqual({});
    writeFileSync(answersPath(), '"just a string"');
    expect(loadGateAnswers()).toEqual({});
  });

  it("round-trips answers and merges keys", () => {
    saveGateAnswer("codexHooksGate", "trust_all");
    saveGateAnswer("codexTrustGate", "yes");
    expect(loadGateAnswers()).toEqual({ codexHooksGate: "trust_all", codexTrustGate: "yes" });
    // Overwrite keeps the other key.
    saveGateAnswer("codexHooksGate", "continue_untrusted");
    expect(loadGateAnswers()).toEqual({
      codexHooksGate: "continue_untrusted",
      codexTrustGate: "yes",
    });
    // File is real JSON on disk.
    expect(JSON.parse(readFileSync(answersPath(), "utf-8")).codexTrustGate).toBe("yes");
  });
});

describe("rememberedGateDigit", () => {
  it("maps hooks choices to their on-screen digits", () => {
    expect(rememberedGateDigit("hooks")).toBeNull();
    saveGateAnswer("codexHooksGate", "trust_all");
    expect(rememberedGateDigit("hooks")).toBe("2");
    saveGateAnswer("codexHooksGate", "continue_untrusted");
    expect(rememberedGateDigit("hooks")).toBe("3");
  });

  it("maps the trust choice to 1 and asks otherwise", () => {
    expect(rememberedGateDigit("trust")).toBeNull();
    saveGateAnswer("codexTrustGate", "yes");
    expect(rememberedGateDigit("trust")).toBe("1");
  });
});
