import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { saveUploadFile } from "../src/uploads";

describe("saveUploadFile", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts non-image mime types and uses a matching extension fallback", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("pdf").toString("base64"),
    });

    expect(saved.mimeType).toBe("application/pdf");
    expect(saved.originalName).toBe("file.pdf");
    expect(saved.filePath).toContain("file.pdf");
    expect(existsSync(saved.filePath)).toBe(true);
  });

  it("rejects empty files", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    await expect(
      saveUploadFile({
        sessionId: "session-1",
        projectPath,
        originalName: "",
        mimeType: "text/plain",
        dataBase64: "",
      }),
    ).rejects.toThrow("Empty file");
  });
});
