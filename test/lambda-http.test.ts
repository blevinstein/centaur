import { describe, expect, it } from "vitest";
import { toLambdaResult, toRequest, wrapHandler } from "../src/lambda/http.js";
import { BINARY_BYTES, functionUrlEvent, NON_UTF8_BODY_BASE64 } from "./helpers/lambda-events.js";

describe("toRequest", () => {
  it("rebuilds the URL from domain, path and query", () => {
    const request = toRequest(
      functionUrlEvent({ rawPath: "/slack/bot", rawQueryString: "a=1&b=%20x" }),
    );
    expect(request.url).toBe("https://abc123.lambda-url.us-east-1.on.aws/slack/bot?a=1&b=%20x");
    expect(request.method).toBe("POST");
  });

  it("joins cookies into a cookie header", () => {
    const request = toRequest(functionUrlEvent({ cookies: ["a=1", "b=2"] }));
    expect(request.headers.get("cookie")).toBe("a=1; b=2");
    expect(request.headers.get("content-type")).toBe("application/json");
  });

  it("preserves raw text body exactly", async () => {
    const body = '{"a": 1,  "b":"é"}\n';
    const request = toRequest(functionUrlEvent({ body }));
    expect(await request.text()).toBe(body);
  });

  it("preserves base64-encoded binary bytes", async () => {
    const request = toRequest(
      functionUrlEvent({ body: NON_UTF8_BODY_BASE64, isBase64Encoded: true }),
    );
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(BINARY_BYTES);
  });

  it("sends no body for GET and for missing bodies", async () => {
    expect(toRequest(functionUrlEvent({ method: "GET" })).body).toBeNull();
    expect(toRequest(functionUrlEvent({ method: "GET", body: "x" })).body).toBeNull();
  });
});

describe("toLambdaResult", () => {
  it("returns text bodies as-is", async () => {
    const result = await toLambdaResult(
      new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } }),
    );
    expect(result).toMatchObject({ statusCode: 201, body: '{"ok":true}', isBase64Encoded: false });
  });

  it("base64-encodes binary bodies", async () => {
    const result = await toLambdaResult(
      new Response(BINARY_BYTES, { headers: { "content-type": "application/octet-stream" } }),
    );
    expect(result.body).toBe(NON_UTF8_BODY_BASE64);
    expect(result.isBase64Encoded).toBe(true);
  });

  it("base64-encodes encoded text and responses without content type", async () => {
    const gzipped = await toLambdaResult(
      new Response("x", { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }),
    );
    expect(gzipped.isBase64Encoded).toBe(true);
    const untyped = await toLambdaResult(new Response(null, { status: 204 }));
    expect(untyped).toMatchObject({ statusCode: 204, body: "" });
  });

  it("moves set-cookie values into cookies", async () => {
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    const result = await toLambdaResult(new Response("hi", { headers }));
    expect(result.cookies).toEqual(["a=1; Path=/", "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]);
    expect(result.headers).toEqual({ "content-type": "text/plain" });
  });
});

describe("wrapHandler", () => {
  it("runs the web handler end to end", async () => {
    const handler = wrapHandler(
      async (request) =>
        new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`, {
          headers: { "content-type": "text/plain" },
        }),
    );
    const result = await handler(functionUrlEvent({ body: "ping" }));
    expect(result.body).toBe("POST /telegram/mybot ping");
  });
});
