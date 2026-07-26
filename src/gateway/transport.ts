/**
 * Default HTTP transport for the gateway (epic AIPP-6, subtask 6.2).
 *
 * A thin fetch-based implementation of the provider {@link Transport}: it issues
 * the request the adapter serialized and reads the response body as text. It is
 * injectable so the gateway is tested against mock upstreams without real
 * network access.
 */

import type { Transport } from '../providers/types.js';

/** Perform provider requests using the global fetch implementation. */
export const httpTransport: Transport = async (request, options) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: options?.signal,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.text();
  return { status: response.status, headers, body };
};
