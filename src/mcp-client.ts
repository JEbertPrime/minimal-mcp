/**
 * Minimal MCP Client – Web
 * Specification: 2025-11-25
 *
 * Implemented capabilities
 * ────────────────────────
 * § client/roots       roots               { listChanged: true }
 * § client/sampling    sampling            { tools: {} }
 * § client/elicitation elicitation         { form: {}, url: {} }
 * § utilities/tasks    tasks (experimental){ list, cancel, requests.sampling, requests.elicitation }
 *
 * Implemented base-protocol utilities (no capability flag needed)
 * ───────────────────────────────────────────────────────────────
 * § utilities/ping         – respond to ping from server; client.ping(); optional keepalive
 * § utilities/cancellation – handle incoming notifications/cancelled; send on timeout
 * § utilities/progress     – handle incoming notifications/progress; progressToken in requests
 *
 * Transport: Streamable HTTP (POST + GET SSE), with legacy HTTP+SSE fallback
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2025-11-25";

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 primitives
// ─────────────────────────────────────────────────────────────────────────────

type JSONRPCId = number | string;

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: JSONRPCId;
  method: string;
  params?: unknown;
}
interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
interface JSONRPCSuccessResponse {
  jsonrpc: "2.0";
  id: JSONRPCId;
  result: unknown;
}
interface JSONRPCErrorResponse {
  jsonrpc: "2.0";
  id: JSONRPCId;
  error: { code: number; message: string; data?: unknown };
}
type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse;
type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse;

function isResponse(m: JSONRPCMessage): m is JSONRPCResponse {
  return "id" in m && !("method" in m);
}
function isRequest(m: JSONRPCMessage): m is JSONRPCRequest {
  return "id" in m && "method" in m;
}
function isNotification(m: JSONRPCMessage): m is JSONRPCNotification {
  return !("id" in m) && "method" in m;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP domain types – Roots
// ─────────────────────────────────────────────────────────────────────────────

/** A filesystem root. URI MUST be a file:// URI per the 2025-11-25 spec. */
export interface Root {
  uri: string;
  name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP domain types – Sampling (§ client/sampling)
// ─────────────────────────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface AudioContent {
  type: "audio";
  data: string;
  mimeType: string;
}
export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: Array<TextContent | ImageContent>;
}
export type SamplingContent =
  | TextContent
  | ImageContent
  | AudioContent
  | ToolUseContent
  | ToolResultContent;

export interface SamplingMessage {
  role: "user" | "assistant";
  content: SamplingContent | SamplingContent[];
}
export interface SamplingTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface ModelPreferences {
  hints?: Array<{ name: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}
export interface SamplingCreateMessageParams {
  messages: SamplingMessage[];
  modelPreferences?: ModelPreferences;
  systemPrompt?: string;
  includeContext?: "none" | "thisServer" | "allServers";
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
  tools?: SamplingTool[];
  toolChoice?: { mode: "auto" | "required" | "none" };
  task?: { ttl?: number };
  _meta?: Record<string, unknown>;
}
export interface SamplingCreateMessageResult {
  role: "assistant";
  content: SamplingContent | SamplingContent[];
  model: string;
  stopReason?: "endTurn" | "maxTokens" | "stopSequence" | "toolUse";
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP domain types – Elicitation (§ client/elicitation)
// ─────────────────────────────────────────────────────────────────────────────

export type PropertySchema =
  | {
      type: "string";
      title?: string;
      description?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      format?: string;
      default?: string;
      enum?: string[];
      oneOf?: Array<{ const: string; title: string }>;
    }
  | {
      type: "number" | "integer";
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | {
      type: "array";
      title?: string;
      description?: string;
      minItems?: number;
      maxItems?: number;
      items: {
        type: "string";
        enum?: string[];
        anyOf?: Array<{ const: string; title: string }>;
      };
      default?: string[];
    };

export interface FormElicitationParams {
  mode?: "form";
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
  task?: { ttl?: number };
  _meta?: Record<string, unknown>;
}
export interface UrlElicitationParams {
  mode: "url";
  elicitationId: string;
  url: string;
  message: string;
  task?: { ttl?: number };
  _meta?: Record<string, unknown>;
}
export type ElicitationCreateParams =
  | FormElicitationParams
  | UrlElicitationParams;
export interface ElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP domain types – Tasks (§ basic/utilities/tasks) [experimental]
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";
export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}
export interface CreateTaskResult {
  task: Task;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP domain types – Server info
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerCapabilities {
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  logging?: Record<string, never>;
  completions?: Record<string, never>;
  tasks?: {
    list?: Record<string, never>;
    cancel?: Record<string, never>;
    requests?: { tools?: { call?: Record<string, never> } };
  };
  [key: string]: unknown;
}
export interface ServerInfo {
  name: string;
  version: string;
  title?: string;
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler types
// ─────────────────────────────────────────────────────────────────────────────

export type SamplingHandler = (
  params: SamplingCreateMessageParams,
) => Promise<SamplingCreateMessageResult>;

export type ElicitationHandler = (
  params: ElicitationCreateParams,
) => Promise<ElicitationResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Request options
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestOptions {
  timeoutMs?: number;
  /** Include a progressToken to receive notifications/progress for this request. */
  progressToken?: string | number;
}
export interface TaskRequestOptions extends RequestOptions {
  /** Desired task lifetime in ms (server may override). */
  ttl?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client options
// ─────────────────────────────────────────────────────────────────────────────

export interface MCPClientOptions {
  /** URL of the MCP server's single HTTP endpoint. */
  endpoint: string;
  clientName?: string;
  clientVersion?: string;
  /** Roots to expose immediately after connecting. */
  initialRoots?: Root[];

  /**
   * Handle sampling/createMessage requests from the server.
   * Declaring this automatically enables the `sampling` capability.
   * Implementations SHOULD show the request to the user (human-in-the-loop).
   */
  onSamplingRequest?: SamplingHandler;

  /**
   * Handle elicitation/create requests from the server (form + URL modes).
   * Declaring this automatically enables the `elicitation` capability.
   */
  onElicitationRequest?: ElicitationHandler;

  /**
   * Called for every server notification after built-in handling.
   */
  onNotification?: (method: string, params: unknown) => void;

  /**
   * Called when a notifications/progress arrives for any tracked request.
   */
  onProgress?: (
    token: string | number,
    progress: number,
    total: number | undefined,
    message: string | undefined,
  ) => void;

  /**
   * Opt out of specific capabilities (e.g. for testing).
   */
  capabilities?: {
    sampling?: boolean;
    elicitation?: boolean;
    /** Tasks are auto-enabled when handlers are present. Disable explicitly here. */
    tasks?: boolean;
  };

  /** Default request timeout ms (default: 30 000). */
  defaultTimeoutMs?: number;

  /**
   * Interval ms for server keepalive pings. 0 = disabled (default).
   */
  pingIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}
interface SSEEvent {
  data: string;
  id?: string;
  event?: string;
  retry?: number;
}
/** A task the client is executing as receiver (e.g. for a task-augmented sampling request). */
interface ClientTask extends Task {
  result?: unknown;
  resultError?: { code: number; message: string; data?: unknown };
  resultWaiters: Array<{
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCPClient
// ─────────────────────────────────────────────────────────────────────────────

export class MCPClient extends EventTarget {
  // Config
  private readonly endpoint: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly defaultTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly onSamplingRequest?: SamplingHandler;
  private readonly onElicitationRequest?: ElicitationHandler;
  private readonly onNotificationCb?: (method: string, params: unknown) => void;
  private readonly onProgressCb?: MCPClientOptions["onProgress"];
  private readonly capabilityOverrides: NonNullable<
    MCPClientOptions["capabilities"]
  >;

  // Protocol state
  private negotiatedVersion = PROTOCOL_VERSION;
  private sessionId: string | null = null;
  private nextId = 1;
  private _connected = false;

  // Server info (populated after initialize)
  private _serverCapabilities: ServerCapabilities = {};
  private _serverInfo: ServerInfo | null = null;

  // Roots
  private _roots: Root[];

  // Inflight requests
  private pendingRequests = new Map<JSONRPCId, PendingRequest>();

  // SSE listen stream
  private listenAbort: AbortController | null = null;

  // Keepalive
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Tasks the client is executing as receiver (experimental)
  private clientTasks = new Map<string, ClientTask>();

  // ──────────────────────────────────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────────────────────────────────

  constructor(options: MCPClientOptions) {
    super();
    this.endpoint = options.endpoint;
    this.clientName = options.clientName ?? "minimal-mcp-client";
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 0;
    this.onSamplingRequest = options.onSamplingRequest;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onNotificationCb = options.onNotification;
    this.onProgressCb = options.onProgress;
    this.capabilityOverrides = options.capabilities ?? {};
    this._roots = options.initialRoots
      ? this.validateAndCopyRoots(options.initialRoots)
      : [];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public accessors
  // ──────────────────────────────────────────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }
  get serverCapabilities(): ServerCapabilities {
    return this._serverCapabilities;
  }
  get serverInfo(): ServerInfo | null {
    return this._serverInfo;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Roots API (§ client/roots)
  // ──────────────────────────────────────────────────────────────────────────

  getRoots(): readonly Root[] {
    return this._roots;
  }

  setRoots(roots: Root[]): void {
    this._roots = this.validateAndCopyRoots(roots);
    this.emitRootsChanged();
  }

  addRoot(root: Root): void {
    this.validateRoot(root);
    if (!this._roots.some((r) => r.uri === root.uri)) {
      this._roots = [...this._roots, { ...root }];
      this.emitRootsChanged();
    }
  }

  removeRoot(uri: string): void {
    const before = this._roots.length;
    this._roots = this._roots.filter((r) => r.uri !== uri);
    if (this._roots.length !== before) this.emitRootsChanged();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  async connect(): Promise<ServerInfo> {
    if (this._connected) throw new Error("Already connected");
    await this.initialize();
    this._connected = true;
    this.startListenStream();
    if (this.pingIntervalMs > 0) this.startPingKeepAlive();
    return this._serverInfo!;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.listenAbort?.abort();
    this.listenAbort = null;

    if (this.sessionId) {
      // § Session Management: send DELETE to terminate the session.
      try {
        await fetch(this.endpoint, {
          method: "DELETE",
          headers: this.sessionHeaders(),
        });
      } catch {
        /* best-effort; server may return 405 */
      }
      this.sessionId = null;
    }

    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timeoutId);
      p.reject(new Error("Client disconnected"));
    }
    this.pendingRequests.clear();
    this.dispatchEvent(new Event("disconnect"));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ping (§ basic/utilities/ping)
  // ──────────────────────────────────────────────────────────────────────────

  /** Send a ping to the server. Returns round-trip latency in ms. */
  async ping(timeoutMs?: number): Promise<number> {
    const start = Date.now();
    await this.request<Record<string, never>>("ping", undefined, { timeoutMs });
    return Date.now() - start;
  }

  private startPingKeepAlive(): void {
    this.pingTimer = setInterval(() => {
      if (!this._connected) return;
      this.ping().catch((err: unknown) => {
        this.dispatchEvent(new CustomEvent("ping-failure", { detail: err }));
      });
    }, this.pingIntervalMs);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Request API – client as requestor
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request to the server and await the response.
   * Supports both application/json and text/event-stream response types.
   */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    if (!this._connected) throw new Error("Not connected");

    const id = this.nextId++;

    // § Progress: inject progressToken into _meta if provided.
    let resolvedParams: Record<string, unknown> | undefined = params as
      | Record<string, unknown>
      | undefined;
    if (options?.progressToken !== undefined) {
      resolvedParams = {
        ...(resolvedParams ?? {}),
        _meta: { progressToken: options.progressToken },
      };
    }

    const message: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(resolvedParams !== undefined && { params: resolvedParams }),
    };

    return new Promise<T>((resolve, reject) => {
      const ms = options?.timeoutMs ?? this.defaultTimeoutMs;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        // § Cancellation: send notifications/cancelled on timeout.
        this.sendNotification("notifications/cancelled", {
          requestId: id,
          reason: "Timeout",
        }).catch(() => {});
        reject(new Error(`Request timed out: ${method}`));
      }, ms);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutId,
      });

      this.postMessage(message)
        .then(async (res) => {
          if (!res.ok) {
            this.settlePending(id, undefined, new Error(`HTTP ${res.status}`));
            return;
          }
          const ct = res.headers.get("Content-Type") ?? "";
          if (ct.includes("text/event-stream") && res.body) {
            await this.drainSSEStream(res.body);
          } else {
            this.routeResponse((await res.json()) as JSONRPCResponse);
          }
        })
        .catch((err: unknown) => {
          this.settlePending(
            id,
            undefined,
            err instanceof Error ? err : new Error(String(err)),
          );
        });
    });
  }

  /**
   * Send a task-augmented request (client as requestor).
   * Returns the server's CreateTaskResult. Poll with the helpers below.
   */
  async taskRequest(
    method: string,
    params?: unknown,
    options?: TaskRequestOptions,
  ): Promise<CreateTaskResult> {
    const taskParams = {
      ...(params as Record<string, unknown>),
      task: { ...(options?.ttl !== undefined && { ttl: options.ttl }) },
    };
    return this.request<CreateTaskResult>(method, taskParams, options);
  }

  /** Poll the server for a task's current state. */
  getServerTask(taskId: string): Promise<Task> {
    return this.request<Task>("tasks/get", { taskId });
  }

  /** Block until the server task completes and return its result. */
  waitForServerTaskResult<T = unknown>(taskId: string): Promise<T> {
    return this.request<T>("tasks/result", { taskId });
  }

  /** Cancel a server task. */
  cancelServerTask(taskId: string): Promise<Task> {
    return this.request<Task>("tasks/cancel", { taskId });
  }

  /** List server tasks (requires server to declare tasks.list). */
  listServerTasks(
    cursor?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.request("tasks/list", cursor ? { cursor } : undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Capability declaration
  // ──────────────────────────────────────────────────────────────────────────

  private get samplingEnabled(): boolean {
    return (
      !!this.onSamplingRequest && this.capabilityOverrides.sampling !== false
    );
  }
  private get elicitationEnabled(): boolean {
    return (
      !!this.onElicitationRequest &&
      this.capabilityOverrides.elicitation !== false
    );
  }
  private get tasksEnabled(): boolean {
    return (
      (this.samplingEnabled || this.elicitationEnabled) &&
      this.capabilityOverrides.tasks !== false
    );
  }

  private buildCapabilities(): Record<string, unknown> {
    const cap: Record<string, unknown> = {
      roots: { listChanged: true }, // always declared
    };

    if (this.samplingEnabled) {
      // § Sampling capability – declare tool use support too.
      cap["sampling"] = { tools: {} };
    }

    if (this.elicitationEnabled) {
      // § Elicitation capability – both form and URL modes.
      cap["elicitation"] = { form: {}, url: {} };
    }

    if (this.tasksEnabled) {
      // § Tasks capability (experimental) – list, cancel, and request types for
      //   the request types that this client handles as a receiver.
      const requests: Record<string, unknown> = {};
      if (this.samplingEnabled) requests["sampling"] = { createMessage: {} };
      if (this.elicitationEnabled) requests["elicitation"] = { create: {} };
      cap["tasks"] = { list: {}, cancel: {}, requests };
    }

    return cap;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const id = this.nextId++;
    const initReq: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: this.buildCapabilities(),
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
    };

    let res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initReq),
    });

    // § Backwards compatibility: probe old HTTP+SSE (2024-11-05) on 400/404/405.
    if ([400, 404, 405].includes(res.status)) {
      res = await this.probeOldSSETransport(initReq);
    }

    if (!res.ok) throw new Error(`Initialize failed: HTTP ${res.status}`);

    const sid = res.headers.get("MCP-Session-Id");
    if (sid) this.sessionId = sid;

    const result = await this.readInitializeResult(res, id);

    this.negotiatedVersion = result.protocolVersion ?? PROTOCOL_VERSION;
    this._serverCapabilities = result.capabilities ?? {};
    this._serverInfo = result.serverInfo ?? null;

    // § Lifecycle: send notifications/initialized before any other messages.
    await this.postRaw({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async probeOldSSETransport(
    initReq: JSONRPCRequest,
  ): Promise<Response> {
    const res = await fetch(this.endpoint, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body)
      throw new Error(
        "Server does not support Streamable HTTP or HTTP+SSE transport",
      );

    const postUrl = await this.readOldEndpointEvent(res.body);
    return fetch(postUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initReq),
    });
  }

  private async readOldEndpointEvent(
    body: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, remainder } = this.extractSSEEvents(buf);
        buf = remainder;
        for (const ev of events) {
          if (ev.event === "endpoint" && ev.data) return ev.data;
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error("Old HTTP+SSE server did not send endpoint event");
  }

  private async readInitializeResult(
    res: Response,
    requestId: JSONRPCId,
  ): Promise<{
    protocolVersion: string;
    capabilities: ServerCapabilities;
    serverInfo: ServerInfo;
  }> {
    const ct = res.headers.get("Content-Type") ?? "";
    if (ct.includes("text/event-stream") && res.body) {
      return new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        this.drainSSEStream(res.body!).catch((err: unknown) => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }) as Promise<{
        protocolVersion: string;
        capabilities: ServerCapabilities;
        serverInfo: ServerInfo;
      }>;
    }
    const data = (await res.json()) as JSONRPCResponse;
    if ("error" in data)
      throw new Error(`${data.error.message} (code: ${data.error.code})`);
    return data.result as {
      protocolVersion: string;
      capabilities: ServerCapabilities;
      serverInfo: ServerInfo;
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SSE listen stream (GET)
  // ──────────────────────────────────────────────────────────────────────────

  private startListenStream(): void {
    this.listenAbort = new AbortController();
    const signal = this.listenAbort.signal;

    const run = async (lastEventId?: string): Promise<void> => {
      try {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          ...this.sessionHeaders(),
        };
        if (lastEventId) headers["Last-Event-ID"] = lastEventId;

        const res = await fetch(this.endpoint, {
          method: "GET",
          headers,
          signal,
        });
        if (res.status === 405 || !res.ok) return;
        if (!res.body) return;

        let lastId: string | undefined;
        await this.drainSSEStream(res.body, signal, (ev) => {
          if (ev.id) lastId = ev.id;
        });

        // § SSE polling: reconnect if stream was closed without termination.
        if (!signal.aborted && this._connected) await run(lastId);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (this._connected) {
          await new Promise((r) => setTimeout(r, 2000));
          if (!signal.aborted && this._connected) await run();
        }
      }
    };

    run().catch(console.error);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SSE parsing
  // ──────────────────────────────────────────────────────────────────────────

  private async drainSSEStream(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
    onEvent?: (ev: SSEEvent) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, remainder } = this.extractSSEEvents(buf);
        buf = remainder;
        for (const ev of events) {
          onEvent?.(ev);
          if (ev.data) await this.processSSEData(ev.data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private extractSSEEvents(buf: string): {
    events: SSEEvent[];
    remainder: string;
  } {
    const normalised = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalised.split("\n\n");
    const remainder = parts.pop() ?? "";
    const events: SSEEvent[] = [];
    for (const block of parts) {
      if (!block.trim()) continue;
      const ev = this.parseSSEBlock(block);
      if (ev) events.push(ev);
    }
    return { events, remainder };
  }

  private parseSSEBlock(block: string): SSEEvent | null {
    const ev: SSEEvent = { data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        const v = line.slice(5).trimStart();
        ev.data = ev.data ? `${ev.data}\n${v}` : v;
      } else if (line.startsWith("id:")) {
        ev.id = line.slice(3).trimStart();
      } else if (line.startsWith("event:")) {
        ev.event = line.slice(6).trimStart();
      } else if (line.startsWith("retry:")) {
        const n = parseInt(line.slice(6).trimStart(), 10);
        if (!isNaN(n)) ev.retry = n;
      }
      // Lines starting with ':' are SSE comments — ignore.
    }
    return ev.data ? ev : null;
  }

  private async processSSEData(data: string): Promise<void> {
    let msg: JSONRPCMessage;
    try {
      msg = JSON.parse(data) as JSONRPCMessage;
    } catch {
      console.error("[MCP] Invalid JSON in SSE:", data);
      return;
    }
    await this.routeMessage(msg);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message routing
  // ──────────────────────────────────────────────────────────────────────────

  private async routeMessage(msg: JSONRPCMessage): Promise<void> {
    if (isResponse(msg)) this.routeResponse(msg);
    else if (isRequest(msg)) await this.handleServerRequest(msg);
    else if (isNotification(msg)) this.handleServerNotification(msg);
  }

  private routeResponse(msg: JSONRPCResponse): void {
    const p = this.pendingRequests.get(msg.id);
    if (!p) return;
    this.pendingRequests.delete(msg.id);
    clearTimeout(p.timeoutId);
    if ("error" in msg)
      p.reject(new Error(`${msg.error.message} (code: ${msg.error.code})`));
    else p.resolve(msg.result);
  }

  private settlePending(id: JSONRPCId, result?: unknown, error?: Error): void {
    const p = this.pendingRequests.get(id);
    if (!p) return;
    this.pendingRequests.delete(id);
    clearTimeout(p.timeoutId);
    if (error) p.reject(error);
    else p.resolve(result);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Server-initiated request dispatch
  // ──────────────────────────────────────────────────────────────────────────

  private async handleServerRequest(req: JSONRPCRequest): Promise<void> {
    try {
      const result = await this.dispatchServerRequest(req);
      await this.sendResponse(req.id, result);
    } catch (err) {
      if (err instanceof MCPError) {
        await this.sendErrorResponse(req.id, err.code, err.message, err.data);
      } else {
        await this.sendErrorResponse(req.id, -32603, String(err));
      }
    }
  }

  private async dispatchServerRequest(req: JSONRPCRequest): Promise<unknown> {
    const p = req.params as Record<string, unknown> | undefined;

    switch (req.method) {
      // § basic/utilities/ping
      case "ping":
        return {};

      // § client/roots
      case "roots/list":
        return { roots: this._roots };

      // § client/sampling
      case "sampling/createMessage":
        return this.handleSamplingCreateMessage(
          p as unknown as SamplingCreateMessageParams,
        );

      // § client/elicitation
      case "elicitation/create":
        return this.handleElicitationCreate(
          p as unknown as ElicitationCreateParams,
        );

      // § tasks (client as receiver)
      case "tasks/get":
        return this.handleTaskGet(p);
      case "tasks/result":
        return this.handleTaskResult(p);
      case "tasks/cancel":
        return this.handleTaskCancel(p);
      case "tasks/list":
        return this.handleTaskList(p);

      default:
        // § Error handling: -32601 Method Not Found
        throw new MCPError(-32601, `Method not found: ${req.method}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Sampling handler (§ client/sampling)
  // ──────────────────────────────────────────────────────────────────────────

  private async handleSamplingCreateMessage(
    params: SamplingCreateMessageParams,
  ): Promise<unknown> {
    if (!this.samplingEnabled)
      throw new MCPError(
        -32601,
        "sampling capability not supported by this client",
      );

    const taskField = params.task;
    const relatedMeta = params._meta?.[
      "io.modelcontextprotocol/related-task"
    ] as { taskId?: string } | undefined;

    // § Tasks: task-augmented sampling request.
    if (taskField && this.tasksEnabled) {
      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();
      const task: ClientTask = {
        taskId,
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttl: taskField.ttl ?? null,
        pollInterval: 2000,
        resultWaiters: [],
      };
      this.clientTasks.set(taskId, task);

      // Strip task field from the payload before calling the handler.
      const sanitized: SamplingCreateMessageParams = { ...params };
      delete (sanitized as unknown as Record<string, unknown>)["task"];

      this.runClientTask(
        taskId,
        () => this.onSamplingRequest!(sanitized),
        relatedMeta?.taskId,
      );
      return { task: this.taskSnapshot(task) };
    }

    // Normal (non-task) request.
    const sanitized: SamplingCreateMessageParams = { ...params };
    delete (sanitized as unknown as Record<string, unknown>)["task"];
    return this.onSamplingRequest!(sanitized);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Elicitation handler (§ client/elicitation)
  // ──────────────────────────────────────────────────────────────────────────

  private async handleElicitationCreate(
    params: ElicitationCreateParams,
  ): Promise<unknown> {
    if (!this.elicitationEnabled)
      throw new MCPError(
        -32601,
        "elicitation capability not supported by this client",
      );

    const mode = params.mode ?? "form";
    if (mode !== "form" && mode !== "url")
      throw new MCPError(-32602, `Unknown elicitation mode: ${mode}`);

    const taskField = (params as unknown as Record<string, unknown>)["task"] as
      | { ttl?: number }
      | undefined;
    const relatedMeta = params._meta?.[
      "io.modelcontextprotocol/related-task"
    ] as { taskId?: string } | undefined;

    // § Tasks: task-augmented elicitation request.
    if (taskField && this.tasksEnabled) {
      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();
      const task: ClientTask = {
        taskId,
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttl: taskField.ttl ?? null,
        pollInterval: 2000,
        resultWaiters: [],
      };
      this.clientTasks.set(taskId, task);

      const sanitized: ElicitationCreateParams = { ...params };
      delete (sanitized as unknown as Record<string, unknown>)["task"];

      this.runClientTask(
        taskId,
        () => this.onElicitationRequest!(sanitized),
        relatedMeta?.taskId,
      );
      return { task: this.taskSnapshot(task) };
    }

    const sanitized: ElicitationCreateParams = { ...params };
    delete (sanitized as unknown as Record<string, unknown>)["task"];
    return this.onElicitationRequest!(sanitized);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Client-side task execution (§ basic/utilities/tasks – client as receiver)
  // ──────────────────────────────────────────────────────────────────────────

  private runClientTask(
    taskId: string,
    fn: () => Promise<unknown>,
    _parentTaskId?: string,
  ): void {
    fn()
      .then((result) => this.finishClientTask(taskId, result, null))
      .catch((err: unknown) => this.finishClientTask(taskId, null, err));
  }

  private finishClientTask(
    taskId: string,
    result: unknown,
    err: unknown,
  ): void {
    const task = this.clientTasks.get(taskId);
    if (!task) return;
    const now = new Date().toISOString();
    task.lastUpdatedAt = now;
    if (err) {
      task.status = "failed";
      task.statusMessage = String(err);
      task.resultError = { code: -32603, message: String(err) };
    } else {
      task.status = "completed";
      task.result = result;
    }
    // Notify waiters.
    for (const w of task.resultWaiters) {
      if (task.resultError) w.reject(new Error(task.resultError.message));
      else w.resolve(result);
    }
    task.resultWaiters = [];
    // § notifications/tasks/status: optional status change notification.
    if (this._connected) {
      this.sendNotification(
        "notifications/tasks/status",
        this.taskSnapshot(task),
      ).catch(console.error);
    }
    this.dispatchEvent(
      new CustomEvent("task-status", { detail: this.taskSnapshot(task) }),
    );
  }

  private taskSnapshot(task: ClientTask): Task {
    return {
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttl: task.ttl,
      pollInterval: task.pollInterval,
    };
  }

  // ── tasks/get ────────────────────────────────────────────────────────────

  private handleTaskGet(params: unknown): Task {
    const { taskId } = params as { taskId: string };
    const task = this.clientTasks.get(taskId);
    if (!task) throw new MCPError(-32602, `Task not found: ${taskId}`);
    return this.taskSnapshot(task);
  }

  // ── tasks/result ─────────────────────────────────────────────────────────

  private async handleTaskResult(params: unknown): Promise<unknown> {
    const { taskId } = params as { taskId: string };
    const task = this.clientTasks.get(taskId);
    if (!task) throw new MCPError(-32602, `Task not found: ${taskId}`);

    if (isTerminalStatus(task.status)) return this.wrapTaskResult(task);

    // § tasks/result blocks until terminal status.
    return new Promise<unknown>((resolve, reject) => {
      task.resultWaiters.push({
        resolve: (v) => resolve(this.wrapTaskResult(task, v)),
        reject,
      });
    });
  }

  private wrapTaskResult(task: ClientTask, fallback?: unknown): unknown {
    const r = task.result ?? fallback;
    if (r !== null && typeof r === "object") {
      // § Related Task Metadata: tasks/result MUST include related-task in _meta.
      return {
        ...(r as Record<string, unknown>),
        _meta: {
          ...((r as Record<string, unknown>)["_meta"] as
            | Record<string, unknown>
            | undefined),
          "io.modelcontextprotocol/related-task": { taskId: task.taskId },
        },
      };
    }
    return r;
  }

  // ── tasks/cancel ─────────────────────────────────────────────────────────

  private handleTaskCancel(params: unknown): Task {
    const { taskId } = params as { taskId: string };
    const task = this.clientTasks.get(taskId);
    if (!task) throw new MCPError(-32602, `Task not found: ${taskId}`);
    if (isTerminalStatus(task.status))
      throw new MCPError(
        -32602,
        `Cannot cancel task already in terminal status '${task.status}'`,
      );

    task.status = "cancelled";
    task.statusMessage = "Cancelled by server request.";
    task.lastUpdatedAt = new Date().toISOString();

    for (const w of task.resultWaiters) w.reject(new Error("Task cancelled"));
    task.resultWaiters = [];

    this.dispatchEvent(
      new CustomEvent("task-status", { detail: this.taskSnapshot(task) }),
    );
    return this.taskSnapshot(task);
  }

  // ── tasks/list ───────────────────────────────────────────────────────────

  private handleTaskList(params: unknown): {
    tasks: Task[];
    nextCursor?: string;
  } {
    const { cursor } = (params ?? {}) as { cursor?: string };
    const all = [...this.clientTasks.values()].map((t) => this.taskSnapshot(t));
    const pageSize = 20;
    let start = 0;
    if (cursor) {
      try {
        start = parseInt(atob(cursor), 10);
      } catch {
        /* ignore malformed cursor */
      }
    }
    const page = all.slice(start, start + pageSize);
    const out: { tasks: Task[]; nextCursor?: string } = { tasks: page };
    if (start + pageSize < all.length)
      out.nextCursor = btoa(String(start + pageSize));
    return out;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Server notification dispatch
  // ──────────────────────────────────────────────────────────────────────────

  private handleServerNotification(notif: JSONRPCNotification): void {
    const p = notif.params as Record<string, unknown> | undefined;

    switch (notif.method) {
      // § basic/utilities/cancellation – server cancels an in-flight request.
      case "notifications/cancelled": {
        const requestId = p?.["requestId"] as JSONRPCId | undefined;
        if (requestId !== undefined) {
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeoutId);
            this.pendingRequests.delete(requestId);
            pending.reject(new Error("Request cancelled by server"));
          }
        }
        break;
      }

      // § basic/utilities/progress – progress update for a tracked request.
      case "notifications/progress": {
        const token = p?.["progressToken"] as string | number | undefined;
        const progress = p?.["progress"] as number | undefined;
        const total = p?.["total"] as number | undefined;
        const message = p?.["message"] as string | undefined;
        if (token !== undefined && progress !== undefined) {
          this.onProgressCb?.(token, progress, total, message);
          this.dispatchEvent(
            new CustomEvent("progress", {
              detail: { token, progress, total, message },
            }),
          );
        }
        break;
      }

      // § basic/utilities/tasks – server-side task status update (client as requestor).
      case "notifications/tasks/status": {
        const taskData = p as Task | undefined;
        if (taskData) {
          this.dispatchEvent(
            new CustomEvent("server-task-status", { detail: taskData }),
          );
        }
        break;
      }

      // § client/elicitation – out-of-band elicitation completed.
      case "notifications/elicitation/complete": {
        const elicitationId = p?.["elicitationId"] as string | undefined;
        if (elicitationId) {
          this.dispatchEvent(
            new CustomEvent("elicitation-complete", {
              detail: { elicitationId },
            }),
          );
        }
        break;
      }

      // The client never sends roots/list_changed to itself.
      case "notifications/roots/list_changed":
        break;
    }

    this.onNotificationCb?.(notif.method, notif.params);
    this.dispatchEvent(
      new CustomEvent("notification", {
        detail: { method: notif.method, params: notif.params },
      }),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Roots helpers
  // ──────────────────────────────────────────────────────────────────────────

  private emitRootsChanged(): void {
    if (!this._connected) return;
    // § Root List Changes
    this.sendNotification("notifications/roots/list_changed").catch(
      console.error,
    );
    this.dispatchEvent(
      new CustomEvent("roots-changed", { detail: this._roots }),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Transport helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async sendResponse(id: JSONRPCId, result: unknown): Promise<void> {
    await this.postRaw({
      jsonrpc: "2.0",
      id,
      result,
    } satisfies JSONRPCSuccessResponse);
  }

  private async sendErrorResponse(
    id: JSONRPCId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    await this.postRaw({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined && { data }) },
    } satisfies JSONRPCErrorResponse);
  }

  private async sendNotification(
    method: string,
    params?: unknown,
  ): Promise<void> {
    await this.postRaw({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined && { params }),
    } satisfies JSONRPCNotification);
  }

  /** POST a message and return the raw Response. Handles 404 session-expiry. */
  private async postMessage(msg: JSONRPCMessage): Promise<Response> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.postHeaders(),
      body: JSON.stringify(msg),
    });
    if (res.status === 404 && this.sessionId) {
      this.sessionId = null;
      this._connected = false;
      this.dispatchEvent(new CustomEvent("session-expired"));
      throw new Error("Session expired (HTTP 404). Call connect() to restart.");
    }
    return res;
  }

  /** POST and discard the response body (notifications, responses to server requests). */
  private async postRaw(msg: JSONRPCMessage): Promise<void> {
    try {
      await this.postMessage(msg);
    } catch (err) {
      // Notifications/responses are fire-and-forget — surface via event only.
      this.dispatchEvent(new CustomEvent("send-error", { detail: err }));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Root validation (§ Security Considerations)
  // ──────────────────────────────────────────────────────────────────────────

  private validateAndCopyRoots(roots: Root[]): Root[] {
    roots.forEach((r) => this.validateRoot(r));
    return roots.map((r) => ({ ...r }));
  }

  private validateRoot(root: Root): void {
    let url: URL;
    try {
      url = new URL(root.uri);
    } catch {
      throw new Error(`Root URI is not a valid URL: ${root.uri}`);
    }

    if (url.protocol !== "file:")
      throw new Error(
        `Root URI must use file:// scheme (got "${url.protocol}"): ${root.uri}`,
      );

    if (url.pathname.split("/").some((s) => s === ".."))
      throw new Error(
        `Root URI contains path traversal ("..") segments: ${root.uri}`,
      );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Headers
  // ──────────────────────────────────────────────────────────────────────────

  private postHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.sessionHeaders(),
    };
  }

  private sessionHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "MCP-Protocol-Version": this.negotiatedVersion,
    };
    if (this.sessionId) h["MCP-Session-Id"] = this.sessionId;
    return h;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isTerminalStatus(s: TaskStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

class MCPError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}
