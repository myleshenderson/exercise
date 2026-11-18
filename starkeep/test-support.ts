/**
 * Test doubles shared by the server tests (not a test file itself).
 */

import type { AppCredentials } from "@starkeep/app-client";

export const TEST_CREDS: AppCredentials = {
  appId: "exercise",
  hmacSecret: "test-hmac-secret",
  dataServerUrl: "http://data.test",
};

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

export function mcpHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
