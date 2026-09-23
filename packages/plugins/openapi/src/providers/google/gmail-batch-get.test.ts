import { expect, it } from "vitest";

import {
  GMAIL_BATCH_GET_MAX_IDS,
  buildGmailBatchGetRequest,
  parseGmailBatchGetArgs,
  parseGmailBatchResponse,
} from "./gmail-batch-get";

const valid = (ids: readonly string[]) => ({ userId: "me", format: "full", ids });

it("accepts one to ten distinct message ids", () => {
  const parsed = parseGmailBatchGetArgs(valid(["abc", "def"]));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.ids).toEqual(["abc", "def"]);
});

it("rejects a list longer than the cap", () => {
  const ids = Array.from({ length: GMAIL_BATCH_GET_MAX_IDS + 1 }, (_, index) => `id${index}`);
  const parsed = parseGmailBatchGetArgs(valid(ids));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.message).toContain(`at most ${GMAIL_BATCH_GET_MAX_IDS}`);
});

it("rejects duplicates, a bad id, the wrong user, and a non-full format", () => {
  expect(parseGmailBatchGetArgs(valid(["same", "same"])).ok).toBe(false);
  expect(parseGmailBatchGetArgs(valid(["has/slash"])).ok).toBe(false);
  expect(parseGmailBatchGetArgs({ userId: "them", format: "full", ids: ["abc"] }).ok).toBe(false);
  expect(parseGmailBatchGetArgs({ userId: "me", format: "metadata", ids: ["abc"] }).ok).toBe(false);
  expect(parseGmailBatchGetArgs({ userId: "me", format: "full", ids: [] }).ok).toBe(false);
});

it("builds one inner GET per id against Gmail's batch endpoint", () => {
  const built = buildGmailBatchGetRequest(["msgA", "msgB"]);
  expect(built.url).toBe("https://gmail.googleapis.com/batch/gmail/v1");
  expect(built.body).toContain("GET /gmail/v1/users/me/messages/msgA?format=full HTTP/1.1");
  expect(built.body).toContain("GET /gmail/v1/users/me/messages/msgB?format=full HTTP/1.1");
  expect(built.body).not.toContain("msgA/../");
  expect(built.body.match(/GET /g)).toHaveLength(2);
});

it("parses a multipart batch response in request order", () => {
  const body = [
    "--batch_test",
    "Content-Type: application/http",
    "Content-ID: <response-item0>",
    "",
    "HTTP/1.1 200 OK",
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ id: "msgA", snippet: "hello" }),
    "",
    "--batch_test",
    "Content-Type: application/http",
    "Content-ID: <response-item1>",
    "",
    "HTTP/1.1 404 Not Found",
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ error: { code: 404, message: "not found" } }),
    "",
    "--batch_test--",
    "",
  ].join("\r\n");

  const parsed = parseGmailBatchResponse("multipart/mixed; boundary=batch_test", body, [
    "msgA",
    "msgB",
  ]);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.messages).toEqual([
    { id: "msgA", ok: true, status: 200, message: { id: "msgA", snippet: "hello" } },
    { id: "msgB", ok: false, status: 404, error: { error: { code: 404, message: "not found" } } },
  ]);
});

it("refuses a batch response whose part count does not match the request", () => {
  const parsed = parseGmailBatchResponse(
    "multipart/mixed; boundary=batch_test",
    "--batch_test\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{}\r\n--batch_test--",
    ["msgA", "msgB"],
  );
  expect(parsed.ok).toBe(false);
});
