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

  it("sanitizes filenames by replacing spaces with underscores", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "My Photo.jpg",
      mimeType: "image/jpeg",
      dataBase64: Buffer.from("image").toString("base64"),
    });

    expect(saved.originalName).toBe("My_Photo.jpg");
    expect(saved.filePath).toContain("My_Photo.jpg");
  });

  it("sanitizes filenames by replacing @ with underscores", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "file@path.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("text").toString("base64"),
    });

    expect(saved.originalName).toBe("file_path.txt");
    expect(saved.filePath).toContain("file_path.txt");
  });

  it("sanitizes filenames by replacing quotes and shell chars with underscores", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "file\"name'with`$chars.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("pdf").toString("base64"),
    });

    expect(saved.originalName).toBe("file_name_with__chars.pdf");
    expect(saved.filePath).toContain("file_name_with__chars.pdf");
  });

  it("blocks path traversal attempts in filenames", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "../../etc/passwd",
      mimeType: "text/plain",
      dataBase64: Buffer.from("text").toString("base64"),
    });

    expect(saved.originalName).toBe("passwd");
    expect(saved.filePath).toContain("passwd");
    expect(saved.filePath).not.toContain("../");
  });

  it("strips leading dots from filenames", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "...hidden.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("text").toString("base64"),
    });

    expect(saved.originalName).toBe("hidden.txt");
    expect(saved.filePath).toContain("hidden.txt");
  });

  it("preserves safe punctuation and alphanumeric characters", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "file-name_2024.final.v3.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("pdf").toString("base64"),
    });

    expect(saved.originalName).toBe("file-name_2024.final.v3.pdf");
    expect(saved.filePath).toContain("file-name_2024.final.v3.pdf");
  });

  it("handles filenames with multiple spaces in a row", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "tb-upload-"));
    dirs.push(projectPath);

    const saved = await saveUploadFile({
      sessionId: "session-1",
      projectPath,
      originalName: "file   with   spaces.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("text").toString("base64"),
    });

    expect(saved.originalName).toBe("file___with___spaces.txt");
    expect(saved.filePath).toContain("file___with___spaces.txt");
  });
});
