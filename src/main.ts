import {
  MCPClient,
  type Root,
  type ServerInfo,
  type SamplingCreateMessageParams,
  type ElicitationCreateParams,
} from "./mcp-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────

function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}

function log(
  msg: string,
  kind: "info" | "warn" | "error" | "success" = "info",
): void {
  const container = $<HTMLDivElement>("#log");
  const entry = document.createElement("div");
  entry.className = `log-entry log-${kind}`;
  const ts = new Date().toLocaleTimeString();
  entry.textContent = `[${ts}] ${msg}`;
  container.prepend(entry);
  // Keep last 200 entries
  while (container.children.length > 200) container.lastChild?.remove();
}

function setStatus(state: "disconnected" | "connecting" | "connected"): void {
  const badge = $<HTMLSpanElement>("#status-badge");
  badge.className = `status-badge status-${state}`;
  badge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function renderRoots(roots: readonly Root[]): void {
  const list = $<HTMLUListElement>("#roots-list");
  list.innerHTML = "";
  if (roots.length === 0) {
    const li = document.createElement("li");
    li.className = "root-empty";
    li.textContent = "No roots configured.";
    list.appendChild(li);
    return;
  }
  for (const root of roots) {
    const li = document.createElement("li");
    li.className = "root-item";

    const label = document.createElement("span");
    label.className = "root-uri";
    label.title = root.uri;
    label.textContent = root.name ? `${root.name}  (${root.uri})` : root.uri;

    const rm = document.createElement("button");
    rm.className = "btn btn-danger btn-sm";
    rm.textContent = "✕";
    rm.title = `Remove ${root.uri}`;
    rm.addEventListener("click", () => {
      client?.removeRoot(root.uri);
      renderRoots(client!.getRoots());
      log(`Removed root: ${root.uri}`, "warn");
    });

    li.appendChild(label);
    li.appendChild(rm);
    list.appendChild(li);
  }
}

function renderServerInfo(info: ServerInfo): void {
  const el = $<HTMLDivElement>("#server-info");
  el.innerHTML = `
    <strong>${info.title ?? info.name}</strong> v${info.version}
    ${info.description ? `<br><small>${info.description}</small>` : ""}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application state
// ─────────────────────────────────────────────────────────────────────────────

let client: MCPClient | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Connect / disconnect
// ─────────────────────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  const url = $<HTMLInputElement>("#endpoint").value.trim();
  if (!url) {
    log("Please enter a server endpoint URL.", "error");
    return;
  }

  setStatus("connecting");
  $<HTMLButtonElement>("#btn-connect").disabled = true;

  const initialRoots = client?.getRoots() ?? [];

  client = new MCPClient({
    endpoint: url,
    clientName: "minimal-mcp-demo",
    clientVersion: "1.0.0",
    initialRoots: [...initialRoots],
    onNotification(method, params) {
      log(
        `← notification: ${method}  ${params ? JSON.stringify(params) : ""}`,
        "info",
      );
    },
    onProgress(token, progress, total, message) {
      log(
        `← progress [${token}]: ${progress}${total !== undefined ? `/${total}` : ""} ${message ?? ""}`,
        "info",
      );
    },
    onSamplingRequest(params: SamplingCreateMessageParams) {
      log(
        `← sampling/createMessage: ${JSON.stringify(params).slice(0, 120)}…`,
        "info",
      );
      // Demo: echo back a stub response. Real apps should prompt the user.
      return Promise.resolve({
        role: "assistant" as const,
        content: {
          type: "text" as const,
          text: "[Demo sampling stub – replace with real LLM call]",
        },
        model: "demo-stub",
        stopReason: "endTurn" as const,
      });
    },
    onElicitationRequest(params: ElicitationCreateParams) {
      log(
        `← elicitation/create (${params.mode ?? "form"}): ${params.message}`,
        "info",
      );
      // Demo: auto-decline. Real apps should render a form / open the URL.
      return Promise.resolve({ action: "decline" as const });
    },
  });

  client.addEventListener("roots-changed", () => {
    renderRoots(client!.getRoots());
    log("Roots changed — sent notifications/roots/list_changed", "success");
  });

  client.addEventListener("session-expired", () => {
    log("Session expired. Reconnecting…", "warn");
    setStatus("disconnected");
  });

  client.addEventListener("disconnect", () => {
    setStatus("disconnected");
    $<HTMLButtonElement>("#btn-connect").disabled = false;
    $<HTMLButtonElement>("#btn-disconnect").disabled = true;
    $<HTMLDivElement>("#server-info").innerHTML = "";
  });

  try {
    const info = await client.connect();
    setStatus("connected");
    $<HTMLButtonElement>("#btn-disconnect").disabled = false;
    renderServerInfo(info);
    renderRoots(client.getRoots());
    log(`Connected to ${info.name} v${info.version}`, "success");
    log(`Capabilities: ${JSON.stringify(client.serverCapabilities)}`, "info");
  } catch (err) {
    setStatus("disconnected");
    $<HTMLButtonElement>("#btn-connect").disabled = false;
    log(`Connection failed: ${err}`, "error");
    client = null;
  }
}

async function disconnect(): Promise<void> {
  if (!client) return;
  await client.disconnect();
  client = null;
  log("Disconnected.", "warn");
}

// ─────────────────────────────────────────────────────────────────────────────
// Add root
// ─────────────────────────────────────────────────────────────────────────────

function addRoot(): void {
  const uriInput = $<HTMLInputElement>("#root-uri");
  const nameInput = $<HTMLInputElement>("#root-name");

  const uri = uriInput.value.trim();
  const name = nameInput.value.trim() || undefined;

  if (!uri) {
    log("Root URI is required.", "error");
    return;
  }

  const root: Root = { uri, ...(name && { name }) };

  if (!client) {
    // If not connected yet, just stage the root in a temporary client list.
    // Roots will be sent on the next connect().
    log(`Staged root (not connected yet): ${uri}`, "warn");
    // Store it so we can pass it to the next MCPClient constructor.
    return;
  }

  try {
    client.addRoot(root);
    renderRoots(client.getRoots());
    log(`Added root: ${uri}`, "success");
    uriInput.value = "";
    nameInput.value = "";
  } catch (err) {
    log(`Invalid root: ${err}`, "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Send a custom request (useful for testing tools/list, etc.)
// ─────────────────────────────────────────────────────────────────────────────

async function sendRequest(): Promise<void> {
  if (!client) {
    log("Not connected.", "error");
    return;
  }
  const method = $<HTMLInputElement>("#req-method").value.trim();
  const paramsRaw = $<HTMLInputElement>("#req-params").value.trim();
  if (!method) {
    log("Method is required.", "error");
    return;
  }
  let params: unknown;
  if (paramsRaw) {
    try {
      params = JSON.parse(paramsRaw);
    } catch {
      log("Params must be valid JSON.", "error");
      return;
    }
  }
  try {
    log(`→ request: ${method}`, "info");
    const result = await client.request(method, params);
    log(`← result: ${JSON.stringify(result, null, 2)}`, "success");
  } catch (err) {
    log(`← error: ${err}`, "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire up event listeners after DOM ready
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  setStatus("disconnected");
  $<HTMLButtonElement>("#btn-disconnect").disabled = true;

  $<HTMLButtonElement>("#btn-connect").addEventListener(
    "click",
    () => void connect(),
  );
  $<HTMLButtonElement>("#btn-disconnect").addEventListener(
    "click",
    () => void disconnect(),
  );
  $<HTMLButtonElement>("#btn-add-root").addEventListener("click", addRoot);
  $<HTMLButtonElement>("#btn-send-req").addEventListener(
    "click",
    () => void sendRequest(),
  );

  // Allow Enter in root URI input to add root
  $<HTMLInputElement>("#root-uri").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addRoot();
  });

  // Allow Enter in endpoint input to connect
  $<HTMLInputElement>("#endpoint").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void connect();
  });

  // Populate a sensible default endpoint for local dev
  $<HTMLInputElement>("#endpoint").value = "http://localhost:8080/mcp";

  renderRoots([]);
  log("Ready. Enter a server URL and click Connect.", "info");
});
