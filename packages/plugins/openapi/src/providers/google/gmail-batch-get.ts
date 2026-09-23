// Gmail's Discovery document has no messages.batchGet. A synthetic tool is the
// one address whose single policy approval can cover several message bodies;
// a loop of messages.get pauses once per call. The bytes are fetched with
// Google's multipart batch endpoint after that approval, and only for the ids
// in the call.
import { Duration, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ToolResult, type ToolResult as ToolResultValue } from "@executor-js/sdk/core";

export const GMAIL_MESSAGES_BATCH_GET_TOOL = "gmail.users.messages.batchGet";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_BATCH_GET_MAX_IDS = 10;

const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const BATCH_BOUNDARY = "batch_executor_gmail";
// Gmail ids are web-safe tokens. Rejecting anything else keeps an id from
// changing the inner request path.
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type GmailBatchGetArgs = {
  readonly userId: "me";
  readonly format: "full";
  readonly ids: readonly string[];
};

export type GmailBatchGetMessage = {
  readonly id: string;
  readonly ok: boolean;
  readonly status: number;
  readonly message?: unknown;
  readonly error?: unknown;
};

export const parseGmailBatchGetArgs = (
  args: unknown,
):
  | { readonly ok: true; readonly value: GmailBatchGetArgs }
  | { readonly ok: false; readonly message: string } => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, message: "gmail.users.messages.batchGet expects an object of arguments" };
  }
  const record = args as Record<string, unknown>;
  if (record.userId !== "me") {
    return { ok: false, message: 'userId must be "me"' };
  }
  if (record.format !== "full") {
    return {
      ok: false,
      message: 'format must be "full"; message headers are read on the metadata integration',
    };
  }
  const ids = record.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, message: "ids must be a non-empty array of Gmail message ids" };
  }
  if (ids.length > GMAIL_BATCH_GET_MAX_IDS) {
    return {
      ok: false,
      message: `ids accepts at most ${GMAIL_BATCH_GET_MAX_IDS} message ids`,
    };
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !MESSAGE_ID.test(id)) {
      return { ok: false, message: "each id must be a Gmail message id" };
    }
    if (seen.has(id)) {
      return { ok: false, message: "ids must not contain duplicates" };
    }
    seen.add(id);
  }
  return { ok: true, value: { userId: "me", format: "full", ids: ids as string[] } };
};

export const buildGmailBatchGetRequest = (
  ids: readonly string[],
): { readonly url: string; readonly contentType: string; readonly body: string } => {
  const parts = ids.map((id, index) => {
    const path = `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`;
    return [
      `--${BATCH_BOUNDARY}`,
      "Content-Type: application/http",
      `Content-ID: <item${index}>`,
      "",
      `GET ${path} HTTP/1.1`,
      "",
    ].join("\r\n");
  });
  return {
    url: GMAIL_BATCH_URL,
    contentType: `multipart/mixed; boundary=${BATCH_BOUNDARY}`,
    body: `${parts.join("\r\n")}\r\n--${BATCH_BOUNDARY}--\r\n`,
  };
};

const boundaryFromContentType = (contentType: string | null): string | null => {
  if (contentType === null) return null;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  return boundary.length > 0 ? boundary : null;
};

const partPayload = (http: string): { readonly status: number; readonly body: unknown } => {
  const statusMatch = /HTTP\/\d+(?:\.\d+)?\s+(\d{3})/.exec(http);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const separator = /\r?\n\r?\n/.exec(http);
  const raw = separator ? http.slice(separator.index + separator[0].length).trim() : "";
  if (raw.length === 0) return { status, body: null };
  try {
    return { status, body: JSON.parse(raw) as unknown };
  } catch {
    return { status, body: { raw: raw.slice(0, 500) } };
  }
};

export const parseGmailBatchResponse = (
  contentType: string | null,
  body: string,
  ids: readonly string[],
):
  | { readonly ok: true; readonly messages: readonly GmailBatchGetMessage[] }
  | { readonly ok: false; readonly message: string } => {
  const boundary = boundaryFromContentType(contentType);
  if (boundary === null) {
    return { ok: false, message: "Gmail batch response did not name a multipart boundary" };
  }
  const chunks = body.split(`--${boundary}`);
  const httpParts = chunks
    .map((chunk) => chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, ""))
    .filter((chunk) => chunk.length > 0 && chunk !== "--" && /HTTP\/\d/.test(chunk));
  if (httpParts.length !== ids.length) {
    return {
      ok: false,
      message: `Gmail batch response had ${httpParts.length} parts for ${ids.length} ids`,
    };
  }
  const messages = httpParts.map((part, index) => {
    const id = ids[index] ?? "";
    const headerEnd = /\r?\n\r?\n/.exec(part);
    const http = headerEnd ? part.slice(headerEnd.index + headerEnd[0].length) : part;
    const parsed = partPayload(http.startsWith("HTTP/") ? http : part);
    const succeeded = parsed.status >= 200 && parsed.status < 300;
    return {
      id,
      ok: succeeded,
      status: parsed.status,
      ...(succeeded ? { message: parsed.body } : { error: parsed.body }),
    };
  });
  return { ok: true, messages };
};

export const invokeGmailMessagesBatchGet = (input: {
  readonly args: unknown;
  readonly authorization: string | undefined;
}): Effect.Effect<ToolResultValue<unknown>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const parsed = parseGmailBatchGetArgs(input.args);
    if (!parsed.ok) {
      return ToolResult.fail({ code: "invalid_tool_arguments", message: parsed.message });
    }
    if (!input.authorization?.startsWith("Bearer ")) {
      return ToolResult.fail({
        code: "oauth_connection_missing",
        message: "The Gmail connection has no bearer token to batch-read messages with.",
      });
    }
    const built = buildGmailBatchGetRequest(parsed.value.ids);
    let request = HttpClientRequest.post(built.url);
    request = HttpClientRequest.setHeader(request, "Authorization", input.authorization);
    request = HttpClientRequest.setHeader(request, "Content-Type", built.contentType);
    request = HttpClientRequest.bodyText(request, built.body, built.contentType);
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (response === null) {
      return ToolResult.fail({
        code: "upstream_unreachable",
        message: "Could not reach Gmail to batch-read messages.",
      });
    }
    const text = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
    if (response.status === 401) {
      return ToolResult.fail({
        code: "connection_rejected",
        status: 401,
        message:
          "Gmail rejected the credentials for this batch read. Re-authenticate the connection.",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return ToolResult.fail({
        code: "upstream_http_error",
        status: response.status,
        message: `Gmail batch read returned HTTP ${response.status}`,
      });
    }
    const messages = parseGmailBatchResponse(
      response.headers["content-type"] ?? null,
      text,
      parsed.value.ids,
    );
    if (!messages.ok) {
      return ToolResult.fail({ code: "upstream_http_error", message: messages.message });
    }
    return ToolResult.ok({ messages: messages.messages });
  });
