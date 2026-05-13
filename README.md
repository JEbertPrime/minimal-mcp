# simple-browser-mcp-client

A zero-dependency MCP client for the browser, implementing the **2025-11-25** version of the [Model Context Protocol](https://modelcontextprotocol.io) specification.

- **Transport**: Streamable HTTP (POST + GET SSE), with automatic fallback to the legacy 2024-11-05 HTTP+SSE transport
- **No Node.js APIs** — runs anywhere `fetch` and `EventTarget` are available (browsers, Deno, Cloudflare Workers, Bun)
- Ships ESM (`dist/mcp-client.js`), CJS (`dist/mcp-client.cjs`) and full TypeScript types (`dist/mcp-client.d.ts`)

---

## Install

```sh
npm install simple-browser-mcp-client
```

---

## Quick start

```ts
import { MCPClient } from 'simple-browser-mcp-client';

const client = new MCPClient({ endpoint: 'https://example.com/mcp' });

const serverInfo = await client.connect();
console.log(serverInfo.name, serverInfo.version);

// List tools
const { tools } = await client.listTools();
console.log(tools.map(t => t.name));

// Call a tool
const result = await client.callTool({
  name: 'roll_dice',
  arguments: { sides: 6 },
});
console.log(result.content);

await client.close();
```

---

## `MCPClientOptions`

Pass these to `new MCPClient(options)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | — | **Required.** URL of the MCP server's single HTTP endpoint. |
| `clientName` | `string` | `"minimal-mcp-client"` | Name sent in `initialize`. |
| `clientVersion` | `string` | `"1.0.0"` | Version sent in `initialize`. |
| `initialRoots` | `Root[]` | `[]` | Filesystem roots exposed to the server immediately after connecting. URIs must use `file://`. |
| `onSamplingRequest` | `SamplingHandler` | — | Handle `sampling/createMessage` requests from the server. Declaring this automatically enables the `sampling` capability. |
| `onElicitationRequest` | `ElicitationHandler` | — | Handle `elicitation/create` requests (form and URL modes). Enables the `elicitation` capability. |
| `onNotification` | `(method, params) => void` | — | Called after every server notification (in addition to any `setNotificationHandler` handlers). |
| `onProgress` | `(token, progress, total?, message?) => void` | — | Called for every `notifications/progress` update. |
| `defaultTimeoutMs` | `number` | `30000` | Default per-request timeout in ms. |
| `pingIntervalMs` | `number` | `0` | Send a keepalive ping to the server every N ms. `0` disables it. |
| `capabilities` | `{ sampling?, elicitation?, tasks? }` | — | Opt individual capabilities in/out explicitly. |

---

## Connection lifecycle

```ts
// Connect — resolves with ServerInfo ({ name, version, title?, description? })
const info = await client.connect();

// Check status
client.connected         // boolean
client.serverInfo        // ServerInfo | null
client.serverCapabilities // ServerCapabilities

// Server's usage instructions (from the initialize response)
const instructions = client.getInstructions();

// Disconnect (or use close() — they're the same)
await client.disconnect();
await client.close();

// React to disconnection
client.addEventListener('disconnect', () => { /* ... */ });
```

---

## Tools

```ts
// List all tools (auto-paginates one page at a time)
const { tools, nextCursor } = await client.listTools();
const { tools: page2 } = await client.listTools({ cursor: nextCursor });

// Call a tool
const result = await client.callTool({ name: 'my_tool', arguments: { key: 'value' } });

// result.isError — true when the tool ran but reported a problem
if (result.isError) {
  console.error(result.content);
} else {
  console.log(result.content);        // Array of content items
  console.log(result.structuredContent); // Machine-readable JSON, if provided
}
```

### Progress tracking

```ts
const result = await client.callTool(
  { name: 'slow_task', arguments: {} },
  {
    onprogress: ({ progress, total }) => {
      console.log(`${progress}/${total ?? '?'}`);
    },
    resetTimeoutOnProgress: true,  // reset the per-request timeout on each update
    maxTotalTimeout: 300_000,       // absolute ceiling regardless of progress
    timeout: 60_000,                // per-reset window
  },
);
```

---

## Resources

```ts
// List resources (paginated)
const { resources, nextCursor } = await client.listResources();

// Read a resource
const { contents } = await client.readResource({ uri: 'config://app' });

// URI templates for dynamic resources
const { resourceTemplates } = await client.listResourceTemplates();

// Subscribe / unsubscribe to change notifications
await client.subscribeResource({ uri: 'config://app' });
client.setNotificationHandler('notifications/resources/updated', async ({ params }) => {
  const p = params as { uri: string };
  const { contents } = await client.readResource({ uri: p.uri });
  console.log('Updated:', contents);
});
await client.unsubscribeResource({ uri: 'config://app' });
```

---

## Prompts

```ts
// List prompts (paginated)
const { prompts, nextCursor } = await client.listPrompts();

// Retrieve a prompt with arguments
const { messages } = await client.getPrompt({
  name: 'review-code',
  arguments: { language: 'typescript' },
});
```

---

## Completions

```ts
const { completion } = await client.complete({
  ref: { type: 'ref/prompt', name: 'review-code' },
  argument: { name: 'language', value: 'ty' },
});
console.log(completion.values); // e.g. ['typescript']
```

---

## Notification handlers

```ts
// Register per-method notification handlers
client.setNotificationHandler('notifications/message', ({ params }) => {
  const { level, data } = params as { level: string; data: unknown };
  console.log(`[${level}]`, data);
});

client.setNotificationHandler('notifications/tools/list_changed', async () => {
  const { tools } = await client.listTools();
  console.log('Tools updated:', tools.length);
});
```

---

## Server-initiated request handlers

Register handlers for methods the server can call on the client (overrides the `onSamplingRequest` / `onElicitationRequest` constructor options for the same method):

```ts
client.setRequestHandler('sampling/createMessage', async ({ params }) => {
  const p = params as { messages: unknown[] };
  // Send p.messages to your LLM and return the result
  return {
    role: 'assistant',
    content: { type: 'text', text: 'Hello from the model' },
    model: 'my-model',
  };
});

client.setRequestHandler('elicitation/create', async ({ params }) => {
  const p = params as { message: string };
  console.log('Server asks:', p.message);
  return { action: 'decline' };
});
```

---

## Roots

The client always declares the `roots` capability. Roots expose filesystem boundaries to the server.

```ts
// Set at construction time
const client = new MCPClient({
  endpoint: '...',
  initialRoots: [{ uri: 'file:///home/user/project', name: 'My Project' }],
});

// Manage at runtime — each change automatically sends notifications/roots/list_changed
client.addRoot({ uri: 'file:///home/user/data', name: 'Data' });
client.removeRoot('file:///home/user/data');
client.setRoots([{ uri: 'file:///home/user/project', name: 'My Project' }]);
client.getRoots(); // readonly Root[]

// Or send the notification manually
await client.sendRootsListChanged();
```

---

## Logging

```ts
await client.setLoggingLevel('warning');
// Severity order (low → high):
// debug | info | notice | warning | error | critical | alert | emergency
```

---

## Ping / keepalive

```ts
// One-shot ping — returns round-trip latency in ms
const rtt = await client.ping();

// Automatic keepalive
const client = new MCPClient({ endpoint: '...', pingIntervalMs: 30_000 });
client.addEventListener('ping-failure', ({ detail }) => console.error(detail));
```

---

## Tasks (experimental)

Tasks enable "call-now, fetch-later" patterns for long-running operations. The server creates a task and the client polls it.

```ts
// Start a task-augmented tool call
const { task } = await client.taskRequest('tools/call', {
  name: 'slow_operation',
  arguments: {},
});

// Poll for status
const status = await client.getServerTask(task.taskId);

// Block until complete
const result = await client.waitForServerTaskResult(task.taskId);

// Cancel
await client.cancelServerTask(task.taskId);

// List all server tasks
const { tasks } = await client.listServerTasks();
```

---

## Raw request

For methods not covered by a typed helper:

```ts
const result = await client.request<{ value: number }>('my/method', { foo: 'bar' });
```

---

## Events

The client extends `EventTarget`. All event `detail` values are typed:

| Event | `detail` | Description |
|---|---|---|
| `disconnect` | — | Connection was closed |
| `notification` | `{ method, params }` | Every server notification |
| `progress` | `{ token, progress, total?, message? }` | Progress update |
| `server-task-status` | `Task` | Server-side task status changed |
| `elicitation-complete` | `{ elicitationId }` | URL elicitation completed out-of-band |
| `task-status` | `Task` | Client-side task status changed |
| `ping-failure` | `unknown` | Keepalive ping failed |
| `session-expired` | — | Server returned 404 (session lost) |
| `send-error` | `unknown` | Fire-and-forget send failed |
| `roots-changed` | `Root[]` | Local roots list changed |

---

## Implemented MCP capabilities

| Capability | Declared as |
|---|---|
| `roots` | `{ listChanged: true }` — always |
| `sampling` | `{ tools: {} }` — when `onSamplingRequest` is provided |
| `elicitation` | `{ form: {}, url: {} }` — when `onElicitationRequest` is provided |
| `tasks` (experimental) | `{ list: {}, cancel: {}, requests: { … } }` — when sampling or elicitation is active |

Base-protocol utilities (no capability flag required): **ping**, **cancellation**, **progress**.

---

## License

[Unlicense](https://unlicense.org) — public domain.
