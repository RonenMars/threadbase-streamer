import type { IncomingMessage } from "http";
import { Readable } from "stream";
import { BodyTooLargeError, readBody } from "../src/api/handlers/http-helpers";

const request = (chunks: string[]) =>
  Readable.from(chunks.map((c) => Buffer.from(c))) as IncomingMessage;

describe("readBody", () => {
  it("parses a body within the bound", async () => {
    await expect(readBody(request(['{"a":', "1}"]), 16)).resolves.toEqual({ a: 1 });
  });

  it("refuses a body that grows past the bound, however it is chunked", async () => {
    const body = JSON.stringify({ a: "x".repeat(64) });
    await expect(readBody(request([body.slice(0, 10), body.slice(10)]), 16)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("bounds a caller that passes no limit", async () => {
    const chunk = "x".repeat(1024 * 1024);
    await expect(readBody(request(Array(5).fill(chunk)))).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
