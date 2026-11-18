import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";

export type WebHandler = (request: Request) => Promise<Response>;
export type FunctionUrlHandler = (
  event: APIGatewayProxyEventV2,
  context?: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

const TEXT_CONTENT_TYPE =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.+\+(json|xml))/i;

export function toRequest(event: APIGatewayProxyEventV2): Request {
  const { http, domainName } = event.requestContext;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const headers = new Headers(event.headers as Record<string, string>);
  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }
  const hasBody = event.body !== undefined && !["GET", "HEAD"].includes(http.method);
  const body = hasBody
    ? Buffer.from(event.body as string, event.isBase64Encoded ? "base64" : "utf8")
    : null;
  return new Request(`https://${domainName}${event.rawPath}${query}`, {
    method: http.method,
    headers,
    body,
  });
}

export async function toLambdaResult(
  response: Response,
): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  const bytes = Buffer.from(await response.arrayBuffer());
  const isText =
    !response.headers.has("content-encoding") &&
    TEXT_CONTENT_TYPE.test(response.headers.get("content-type") ?? "");
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: bytes.toString(isText ? "utf8" : "base64"),
    isBase64Encoded: !isText,
  };
}

export function wrapHandler(handler: WebHandler): FunctionUrlHandler {
  return async (event) => toLambdaResult(await handler(toRequest(event)));
}
