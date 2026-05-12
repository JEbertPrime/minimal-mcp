#!/usr/bin/env node

/**
 * Conformance test client for minimal-mcp.
 *
 * Mirrors the structure of the official MCP TypeScript SDK conformance client
 * but uses the minimal-mcp MCPClient instead of @modelcontextprotocol/client.
 *
 * Usage:
 *   MCP_CONFORMANCE_SCENARIO=<scenario> npx tsx tests/client.ts <server-url>
 *
 * Available scenarios: initialize, tools_call, ping, roots,
 *   elicitation-sep1034-client-defaults, sse-retry
 *
 * Note: OAuth/auth scenarios are not applicable to this browser-first client.
 */

import { MCPClient, type FormElicitationParams } from "../src/mcp-client.js";
import { logger } from "./helpers/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scenario registry
// ─────────────────────────────────────────────────────────────────────────────

type ScenarioHandler = (serverUrl: string) => Promise<void>;
const scenarioHandlers: Record<string, ScenarioHandler> = {};

function registerScenario(name: string, handler: ScenarioHandler): void {
  scenarioHandlers[name] = handler;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: initialize
// Connect, list tools, disconnect.
// ─────────────────────────────────────────────────────────────────────────────

async function runBasicClient(serverUrl: string): Promise<void> {
  const client = new MCPClient({
    endpoint: serverUrl,
    clientName: "test-client",
    clientVersion: "1.0.0",
  });

  await client.connect();
  logger.debug("Successfully connected to MCP server");

  await client.request("tools/list");
  logger.debug("Successfully listed tools");

  await client.disconnect();
  logger.debug("Connection closed successfully");
}

registerScenario("initialize", runBasicClient);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: tools_call
// Connect, list tools, call add_numbers(5, 3).
// ─────────────────────────────────────────────────────────────────────────────

async function runToolsCallClient(serverUrl: string): Promise<void> {
  const client = new MCPClient({
    endpoint: serverUrl,
    clientName: "test-client",
    clientVersion: "1.0.0",
  });

  await client.connect();
  logger.debug("Successfully connected to MCP server");

  const { tools } = await client.request<{ tools: Array<{ name: string }> }>(
    "tools/list",
  );
  logger.debug("Successfully listed tools");

  const addTool = tools.find((t) => t.name === "add_numbers");
  if (addTool) {
    const result = await client.request("tools/call", {
      name: "add_numbers",
      arguments: { a: 5, b: 3 },
    });
    logger.debug("Tool call result:", JSON.stringify(result, null, 2));
  }

  await client.disconnect();
  logger.debug("Connection closed successfully");
}

registerScenario("tools_call", runToolsCallClient);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: ping
// Connect and measure round-trip latency.
// ─────────────────────────────────────────────────────────────────────────────

async function runPingClient(serverUrl: string): Promise<void> {
  const client = new MCPClient({
    endpoint: serverUrl,
    clientName: "ping-test-client",
    clientVersion: "1.0.0",
  });

  await client.connect();
  logger.debug("Successfully connected to MCP server");

  const rtt = await client.ping();
  logger.debug(`Ping RTT: ${rtt}ms`);

  await client.disconnect();
  logger.debug("Connection closed successfully");
}

registerScenario("ping", runPingClient);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: roots
// Connect with an initial root, add a second root, remove it.
// The server should receive roots/list_changed notifications.
// ─────────────────────────────────────────────────────────────────────────────

async function runRootsClient(serverUrl: string): Promise<void> {
  const client = new MCPClient({
    endpoint: serverUrl,
    clientName: "roots-test-client",
    clientVersion: "1.0.0",
    initialRoots: [{ uri: "file:///project", name: "Project" }],
  });

  await client.connect();
  logger.debug("Connected; initial root advertised via roots/list");

  client.addRoot({ uri: "file:///home", name: "Home" });
  logger.debug(
    "Added root file:///home — notifications/roots/list_changed sent",
  );

  // Allow notification delivery
  await new Promise((r) => setTimeout(r, 100));

  client.removeRoot("file:///home");
  logger.debug(
    "Removed root file:///home — notifications/roots/list_changed sent",
  );

  await new Promise((r) => setTimeout(r, 100));

  await client.disconnect();
  logger.debug("Connection closed successfully");
}

registerScenario("roots", runRootsClient);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: elicitation-sep1034-client-defaults
// Connect, declare elicitation capability, respond with empty content and let
// the client fill in schema defaults before sending the accept response.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a form's requestedSchema and fill in declared default values for any
 * key that the handler left unset.  This replicates the `applyDefaults`
 * behaviour that the official SDK provides automatically.
 */
function applyFormDefaults(
  content: Record<string, unknown>,
  schema: FormElicitationParams["requestedSchema"],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...content };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in result) && "default" in prop) {
      result[key] = (prop as { default: unknown }).default;
    }
  }
  return result;
}

async function runElicitationDefaultsClient(serverUrl: string): Promise<void> {
  const client = new MCPClient({
    endpoint: serverUrl,
    clientName: "elicitation-defaults-test-client",
    clientVersion: "1.0.0",
    onElicitationRequest: async (params) => {
      logger.debug(
        "Received elicitation request:",
        JSON.stringify(params, null, 2),
      );

      if ((params.mode ?? "form") !== "form") {
        // URL-mode elicitations are declined in this scenario.
        return { action: "decline" as const };
      }

      const formParams = params as FormElicitationParams;

      logger.debug("Accepting with defaults applied to empty content");
      const content = applyFormDefaults({}, formParams.requestedSchema);
      return { action: "accept" as const, content };
    },
  });

  await client.connect();
  logger.debug("Successfully connected to MCP server");

  const { tools } = await client.request<{ tools: Array<{ name: string }> }>(
    "tools/list",
  );
  logger.debug(
    "Available tools:",
    tools.map((t) => t.name),
  );

  const testTool = tools.find(
    (t) => t.name === "test_client_elicitation_defaults",
  );
  if (!testTool) {
    throw new Error("Test tool not found: test_client_elicitation_defaults");
  }

  logger.debug("Calling test_client_elicitation_defaults tool...");
  const result = await client.request("tools/call", {
    name: "test_client_elicitation_defaults",
    arguments: {},
  });
  logger.debug("Tool result:", JSON.stringify(result, null, 2));

  await client.disconnect();
  logger.debug("Connection closed successfully");
}

registerScenario(
  "elicitation-sep1034-client-defaults",
  runElicitationDefaultsClient,
);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: sse-retry
// Connect, call a tool that causes the server to close the SSE stream, and
// verify the client reconnects automatically and continues to work.
// ─────────────────────────────────────────────────────────────────────────────

async function runSSERetryClient(serverUrl: string): Promise<void> {
  const client = new MCPClient({
    endpoint: serverUrl,
    clientName: "sse-retry-test-client",
    clientVersion: "1.0.0",
  });

  await client.connect();
  logger.debug("Successfully connected to MCP server");

  const { tools } = await client.request<{ tools: Array<{ name: string }> }>(
    "tools/list",
  );
  logger.debug(
    "Available tools:",
    tools.map((t) => t.name),
  );

  const testTool = tools.find((t) => t.name === "test_reconnection");
  if (!testTool) {
    throw new Error("Test tool not found: test_reconnection");
  }

  logger.debug("Calling test_reconnection tool...");
  const result = await client.request("tools/call", {
    name: "test_reconnection",
    arguments: {},
  });
  logger.debug("Tool result:", JSON.stringify(result, null, 2));

  await client.disconnect();
  logger.debug("Connection closed successfully");
}

registerScenario("sse-retry", runSSERetryClient);

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scenarioName = process.env.MCP_CONFORMANCE_SCENARIO;
  const serverUrl = process.argv[2];

  if (!scenarioName || !serverUrl) {
    logger.error(
      "Usage: MCP_CONFORMANCE_SCENARIO=<scenario> npx tsx tests/client.ts <server-url>",
    );
    logger.error("\nAvailable scenarios:");
    for (const name of Object.keys(scenarioHandlers).toSorted()) {
      logger.error(`  - ${name}`);
    }
    process.exit(1);
  }

  const handler = scenarioHandlers[scenarioName];
  if (!handler) {
    logger.error(`Unknown scenario: ${scenarioName}`);
    logger.error("\nAvailable scenarios:");
    for (const name of Object.keys(scenarioHandlers).toSorted()) {
      logger.error(`  - ${name}`);
    }
    process.exit(1);
  }

  try {
    await handler(serverUrl);
    process.exit(0);
  } catch (error) {
    logger.error("Error:", error);
    process.exit(1);
  }
}

await main();
