/**
 * Portal RPC Helper
 *
 * Wraps CDP Runtime.evaluate calls to invoke Superhuman's internal
 * portal.invoke() API: window.GoogleAccount.portal.invoke(service, method, args)
 */

import type { SuperhumanConnection } from "./superhuman-api";

const VALID_NAME = /^[a-zA-Z0-9_]+$/;

/**
 * Invoke a Superhuman portal RPC method via CDP Runtime.evaluate.
 *
 * @param conn - CDP connection with Runtime domain
 * @param service - Portal service name (e.g. "threadInternal", "calendarInternal")
 * @param method - Method name on the service (e.g. "listAsync", "archive")
 * @param args - Array of arguments to pass to the method
 * @returns The resolved value from portal.invoke()
 */
export async function portalInvoke(
  conn: SuperhumanConnection,
  service: string,
  method: string,
  args: any[]
): Promise<any> {
  if (!VALID_NAME.test(service)) {
    throw new Error(`Invalid service name: "${service}"`);
  }
  if (!VALID_NAME.test(method)) {
    throw new Error(`Invalid method name: "${method}"`);
  }

  const argsJson = JSON.stringify(args);
  const expression = `window.GoogleAccount.portal.invoke("${service}", "${method}", ${argsJson})`;

  const response = await conn.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    const desc =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      "Unknown portal error";
    throw new Error(`portalInvoke failed: ${desc}`);
  }

  if (!response.result || response.result.type === "undefined") {
    throw new Error(
      `portalInvoke returned undefined for ${service}.${method} — portal may not be available`
    );
  }

  return response.result.value;
}

/**
 * Check whether the portal API is accessible on the current CDP page.
 */
export async function hasPortalAccess(
  conn: SuperhumanConnection
): Promise<boolean> {
  try {
    const response = await conn.Runtime.evaluate({
      expression:
        "typeof window.GoogleAccount?.portal?.invoke === 'function'",
      awaitPromise: false,
      returnByValue: true,
    });

    if (response.exceptionDetails) {
      return false;
    }

    return response.result?.value === true;
  } catch {
    return false;
  }
}
