import type { APIGatewayProxyEventV2 } from "aws-lambda";

export function functionUrlEvent(
  overrides: Partial<APIGatewayProxyEventV2> & { method?: string } = {},
): APIGatewayProxyEventV2 {
  const { method = "POST", ...rest } = overrides;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/telegram/mybot",
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    isBase64Encoded: false,
    requestContext: {
      accountId: "anonymous",
      apiId: "abc123",
      domainName: "abc123.lambda-url.us-east-1.on.aws",
      domainPrefix: "abc123",
      http: {
        method,
        path: rest.rawPath ?? "/telegram/mybot",
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.1",
        userAgent: "test",
      },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 1767225600000,
    },
    ...rest,
  };
}

export const BINARY_BYTES = Uint8Array.from([0, 255, 128, 10, 13, 200]);
export const NON_UTF8_BODY_BASE64 = Buffer.from(BINARY_BYTES).toString("base64");
