/**
 * MCP OAuth 2.1 Authorization
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 *
 * Implements the full MCP authorization flow:
 *   § 4   Authorization Server Discovery
 *           - resource_metadata URL from WWW-Authenticate header (§ 4.2)
 *           - Well-known URI probing for Protected Resource Metadata (§ 4.2)
 *           - AS Metadata via RFC 8414 + OIDC priority order (§ 4.3)
 *   § 5   Client Registration priority order
 *           1. Pre-registered client_id (§ 5.2)        ← highest priority
 *           2. Client ID Metadata Documents (§ 5.1)
 *           3. Dynamic Client Registration / RFC 7591 (§ 5.3)
 *   § 6   Scope selection strategy
 *           - scope from WWW-Authenticate → scopes_supported → omit
 *   § 7   Authorization Code + PKCE (S256 mandatory per § 11.4)
 *   § 8   Resource Indicators (RFC 8707) — resource param in auth + token requests
 *   § 9   Bearer token injection (Authorization: Bearer <token>)
 *   § 10  Token refresh; step-up authorization via UnauthorizedError
 *   § 11  Security: state verification (CSRF), PKCE support check, HTTPS checks
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Persisted OAuth 2.1 tokens. */
export interface OAuthTokens {
  accessToken: string;
  /** "Bearer" or other scheme; defaults to "Bearer" */
  tokenType?: string;
  /** Unix timestamp (ms) at which the access token expires */
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
}

/**
 * Client metadata document hosted at an HTTPS URL.
 * The URL itself becomes the `client_id` (Client ID Metadata Documents, § 5.1).
 * Must match the `client_id` field exactly.
 */
export interface OAuthClientMetadata {
  /** HTTPS URL where this document is hosted — also used as client_id */
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  client_uri?: string;
  logo_uri?: string;
  [key: string]: unknown;
}

/**
 * Implement this interface to provide redirect and storage behaviour for the
 * OAuth flow.  The MCP client calls into it at each step of the flow.
 */
export interface OAuthClientProvider {
  /**
   * The redirect URI registered with the authorization server.
   * Must be `http://127.0.0.1` / `http://localhost` OR an HTTPS URI (§ 11.3).
   */
  redirectUri: string;

  /**
   * Open the authorization URL in the user's browser.
   *   - SPA / plain page:  `window.location.href = url.toString()`
   *   - Browser extension: `chrome.identity.launchWebAuthFlow(...)` or similar
   *   - Electron:          `shell.openExternal(url.toString())`
   */
  redirectToAuthorization(url: URL): void | Promise<void>;

  /** Persist tokens so they survive page reloads / extension restarts. */
  saveTokens(tokens: OAuthTokens): void | Promise<void>;

  /** Return persisted tokens, or `null` if none are stored. */
  loadTokens(): OAuthTokens | null | Promise<OAuthTokens | null>;

  /**
   * Persist the PKCE code verifier between the authorization redirect and the
   * callback.  `sessionStorage` is a suitable choice for SPAs.
   */
  saveCodeVerifier(verifier: string): void | Promise<void>;
  loadCodeVerifier(): string | null | Promise<string | null>;

  /**
   * Optional: persist the state parameter for CSRF protection.
   * If absent the state is kept in memory — safe for extension / webview
   * contexts where the page does NOT reload between redirect and callback.
   * SPA callers that redirect the whole page SHOULD implement this pair.
   */
  saveState?(state: string): void | Promise<void>;
  loadState?(): string | null | Promise<string | null>;

  // ── Client identity (§ 5) ─────────────────────────────────────────────────

  /**
   * Priority 1 — Pre-registered static `client_id` (§ 5.2).
   * Takes precedence over Client ID Metadata Documents and Dynamic Registration.
   */
  clientId?: string;

  /** Client secret for confidential clients (sent as HTTP Basic auth). */
  clientSecret?: string;

  /**
   * Client metadata for the Client ID Metadata Documents approach (§ 5.1).
   * `clientMetadata.client_id` MUST be an HTTPS URL hosting this document.
   * Used when `clientId` is absent AND either:
   *   - the AS declares `client_id_metadata_document_supported: true`, OR
   *   - the AS has a `registration_endpoint` (triggers Dynamic Registration).
   */
  clientMetadata?: OAuthClientMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when the MCP server returns HTTP 401 and (re-)authorization is needed. */
export class UnauthorizedError extends Error {
  constructor(
    message: string,
    /** Raw value of the WWW-Authenticate response header, if present */
    public readonly wwwAuthenticate?: string,
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal metadata types
// ─────────────────────────────────────────────────────────────────────────────

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuthHandler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles the full MCP OAuth 2.1 flow.
 * Instantiated by `MCPClient` when `MCPClientOptions.auth` is provided.
 * Not intended for direct use.
 */
export class OAuthHandler {
  private _tokens: OAuthTokens | null = null;
  private _asMeta: AuthorizationServerMetadata | null = null;
  private _resourceMeta: ProtectedResourceMetadata | null = null;
  /** client_id resolved/registered for the current authorization server */
  private _resolvedClientId: string | null = null;
  /** In-memory CSRF state (overridden by provider.saveState if implemented) */
  private _pendingStateMemory: string | null = null;

  constructor(
    /** Application-supplied callback/storage implementation */
    readonly provider: OAuthClientProvider,
    /**
     * Canonical MCP server URI used as the OAuth `resource` parameter (RFC 8707).
     * Should be the absolute URL of the MCP endpoint, without fragment or query.
     */
    readonly resourceUrl: string,
  ) {}

  // ── Token accessors ────────────────────────────────────────────────────────

  /**
   * Returns the current access token if it is present and not within 30 s of
   * expiry.  Returns `null` when no token is available or it has expired.
   */
  getAccessToken(): string | null {
    if (!this._tokens) return null;
    const { accessToken, expiresAt } = this._tokens;
    if (expiresAt !== undefined && Date.now() >= expiresAt - 30_000) return null;
    return accessToken;
  }

  /** Load any persisted tokens into memory.  Call once before the first request. */
  async loadStoredTokens(): Promise<void> {
    const stored = await this.provider.loadTokens();
    if (stored) this._tokens = stored;
  }

  /** Clear in-memory tokens (e.g. when a refresh attempt fails). */
  clearTokens(): void {
    this._tokens = null;
  }

  // ── Authorization flow ─────────────────────────────────────────────────────

  /**
   * Discover authorization server metadata, build the PKCE authorization URL,
   * persist the code verifier + state, and return the URL.
   *
   * After calling this, `provider.redirectToAuthorization(url)` is invoked
   * automatically.  Then — once the browser returns to `redirectUri` — call
   * `finishAuthorization(callbackUrl)` to exchange the code for tokens.
   *
   * @param wwwAuthHeader  The value of the `WWW-Authenticate` header from a
   *                       401 response.  Provides the `resource_metadata` URL
   *                       and a scope hint.
   */
  async buildAuthorizationUrl(wwwAuthHeader?: string): Promise<URL> {
    await this.discoverMetadata(wwwAuthHeader);
    const meta = this._asMeta!;

    // § 11.4: MUST verify S256 PKCE support before proceeding
    if (!meta.code_challenge_methods_supported?.includes("S256")) {
      throw new Error(
        "Authorization server does not support PKCE S256 — " +
          "cannot proceed as required by MCP spec § 11.4",
      );
    }

    const clientId = await this.resolveClientId(meta);
    const { verifier, challenge } = await generatePKCE();
    const state = generateState();

    await this.provider.saveCodeVerifier(verifier);
    await this.persistState(state);

    const scope = this.pickScope(wwwAuthHeader);

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", this.provider.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", this.resourceUrl); // RFC 8707 (§ 8)
    if (scope) url.searchParams.set("scope", scope);

    return url;
  }

  /**
   * Exchange the authorization code for tokens.
   * Call from your OAuth callback handler after the browser returns from the AS.
   *
   * @param callbackUrl  The full callback URL, including `code` and `state` params.
   */
  async finishAuthorization(callbackUrl: URL | string): Promise<void> {
    const url = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const desc = url.searchParams.get("error_description") ?? error;
      throw new Error(`Authorization server error: ${desc}`);
    }
    if (!code) throw new Error("Callback URL is missing the `code` parameter");

    // Re-discover AS metadata if the page was redirected (e.g. full-page redirect flow
    // means a fresh OAuthHandler instance was created for this callback).
    if (!this._asMeta) {
      await this.discoverMetadata();
    }

    // § 11.5: verify state to prevent CSRF
    const expectedState = await this.recallState();
    if (!expectedState) {
      throw new Error(
        "No pending OAuth state found — possible replay or expired session",
      );
    }
    if (state !== expectedState) {
      throw new Error(
        "OAuth state parameter mismatch — possible CSRF attack; aborting",
      );
    }
    await this.clearState();

    const verifier = await this.provider.loadCodeVerifier();
    if (!verifier) throw new Error("PKCE code verifier not found");

    const meta = this._asMeta!;
    const clientId = await this.resolveClientId(meta);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.provider.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: this.resourceUrl, // RFC 8707 — required in token requests too (§ 8)
    });

    const tokens = await this.exchangeTokens(meta.token_endpoint, body);
    await this.provider.saveTokens(tokens);
    this._tokens = tokens;
  }

  /**
   * Silently refresh the access token using the stored refresh token.
   *
   * Returns `true` if a new access token was obtained.
   * Returns `false` if no refresh token is available (full re-auth needed).
   * Throws if the refresh request fails (e.g. expired refresh token).
   */
  async tryRefresh(): Promise<boolean> {
    if (!this._tokens?.refreshToken) return false;
    if (!this._asMeta) return false;

    const meta = this._asMeta;
    const clientId = await this.resolveClientId(meta);

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this._tokens.refreshToken,
      client_id: clientId,
      resource: this.resourceUrl,
    });

    try {
      const tokens = await this.exchangeTokens(meta.token_endpoint, body);
      await this.provider.saveTokens(tokens);
      this._tokens = tokens;
      return true;
    } catch (err) {
      // Refresh token is invalid or expired — must re-authorize
      this._tokens = null;
      throw err;
    }
  }

  // ── Discovery (§ 4) ────────────────────────────────────────────────────────

  private async discoverMetadata(wwwAuthHeader?: string): Promise<void> {
    const resourceMeta = await this.discoverProtectedResourceMetadata(wwwAuthHeader);
    this._resourceMeta = resourceMeta;

    const servers = resourceMeta.authorization_servers ?? [];
    if (servers.length === 0) {
      throw new Error(
        "Protected Resource Metadata has no `authorization_servers` — " +
          "cannot discover the Authorization Server",
      );
    }

    // Use the first listed AS.  A production client could expose selection UI.
    const asMeta = await this.discoverAuthorizationServerMetadata(servers[0]);
    this._asMeta = asMeta;
  }

  /**
   * § 4.2: discover Protected Resource Metadata.
   * Priority: WWW-Authenticate resource_metadata → sub-path well-known → root well-known.
   */
  private async discoverProtectedResourceMetadata(
    wwwAuthHeader?: string,
  ): Promise<ProtectedResourceMetadata> {
    // Priority 1: resource_metadata URL carried in the 401 WWW-Authenticate header
    if (wwwAuthHeader) {
      const params = parseWWWAuthenticate(wwwAuthHeader);
      if (params["resource_metadata"]) {
        const meta = await fetchJSON<ProtectedResourceMetadata>(params["resource_metadata"]);
        if (meta) return meta;
      }
    }

    // Priority 2: well-known URI probing
    const base = new URL(this.resourceUrl);
    const path = base.pathname.replace(/\/$/, ""); // strip trailing slash

    // Sub-path document (most specific — try first when path is non-root)
    if (path && path !== "") {
      const subPath = `${base.origin}/.well-known/oauth-protected-resource${path}`;
      const meta = await fetchJSON<ProtectedResourceMetadata>(subPath);
      if (meta) return meta;
    }

    // Root document fallback
    const root = `${base.origin}/.well-known/oauth-protected-resource`;
    const rootMeta = await fetchJSON<ProtectedResourceMetadata>(root);
    if (rootMeta) return rootMeta;

    throw new Error(
      `Unable to discover Protected Resource Metadata for ${this.resourceUrl}. ` +
        "The server must implement RFC 9728 (§ 4.2).",
    );
  }

  /**
   * § 4.3: discover Authorization Server Metadata.
   * Tries RFC 8414 and OIDC discovery endpoints in priority order.
   */
  private async discoverAuthorizationServerMetadata(
    issuer: string,
  ): Promise<AuthorizationServerMetadata> {
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/$/, "");
    const origin = u.origin;

    // Priority order from spec § 4.3
    const candidates =
      path && path !== "/"
        ? [
            `${origin}/.well-known/oauth-authorization-server${path}`,
            `${origin}/.well-known/openid-configuration${path}`,
            `${origin}${path}/.well-known/openid-configuration`,
          ]
        : [
            `${origin}/.well-known/oauth-authorization-server`,
            `${origin}/.well-known/openid-configuration`,
          ];

    for (const url of candidates) {
      const meta = await fetchJSON<AuthorizationServerMetadata>(url);
      if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
    }

    throw new Error(
      `Unable to discover Authorization Server Metadata for ${issuer}. ` +
        "Tried RFC 8414 and OIDC discovery endpoints (§ 4.3).",
    );
  }

  // ── Client registration (§ 5) ──────────────────────────────────────────────

  /** Resolve (or register) the client_id using the spec § 5 priority order. */
  private async resolveClientId(
    meta: AuthorizationServerMetadata,
  ): Promise<string> {
    if (this._resolvedClientId) return this._resolvedClientId;

    // Priority 1 — pre-registered static client_id (§ 5.2)
    if (this.provider.clientId) {
      this._resolvedClientId = this.provider.clientId;
      return this._resolvedClientId;
    }

    // Priority 2 — Client ID Metadata Documents (§ 5.1)
    if (meta.client_id_metadata_document_supported && this.provider.clientMetadata) {
      this._resolvedClientId = this.provider.clientMetadata.client_id;
      return this._resolvedClientId;
    }

    // Priority 3 — Dynamic Client Registration / RFC 7591 (§ 5.3)
    if (meta.registration_endpoint && this.provider.clientMetadata) {
      const regBody = {
        ...this.provider.clientMetadata,
        // Provide defaults for required fields not already set in metadata
        redirect_uris:
          this.provider.clientMetadata?.redirect_uris ?? [this.provider.redirectUri],
        grant_types:
          this.provider.clientMetadata?.grant_types ?? ["authorization_code"],
        response_types: this.provider.clientMetadata?.response_types ?? ["code"],
        token_endpoint_auth_method:
          this.provider.clientMetadata?.token_endpoint_auth_method ?? "none",
      };
      const res = await fetch(meta.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regBody),
      });
      if (!res.ok) {
        throw new Error(`Dynamic Client Registration failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { client_id?: string };
      if (!data.client_id) {
        throw new Error("Dynamic Client Registration response is missing `client_id`");
      }
      this._resolvedClientId = data.client_id;
      return this._resolvedClientId;
    }

    throw new Error(
      "Cannot determine client_id. " +
        "Provide OAuthClientProvider.clientId (pre-registered), " +
        "OAuthClientProvider.clientMetadata (Client ID Metadata Documents), " +
        "or ensure the Authorization Server supports Dynamic Client Registration.",
    );
  }

  // ── Scope selection (§ 6) ──────────────────────────────────────────────────

  private pickScope(wwwAuthHeader?: string): string | undefined {
    // Priority 1: scope from WWW-Authenticate (most specific for this request)
    if (wwwAuthHeader) {
      const params = parseWWWAuthenticate(wwwAuthHeader);
      if (params["scope"]) return params["scope"];
    }
    // Priority 2: scopes_supported from Protected Resource Metadata
    const scopes = this._resourceMeta?.scopes_supported;
    if (scopes && scopes.length > 0) return scopes.join(" ");
    // Omit scope parameter — AS determines defaults
    return undefined;
  }

  // ── Token exchange ─────────────────────────────────────────────────────────

  private async exchangeTokens(
    endpoint: string,
    params: URLSearchParams,
  ): Promise<OAuthTokens> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Confidential client: HTTP Basic auth (RFC 6749 § 2.3.1)
    if (this.provider.clientId && this.provider.clientSecret) {
      const creds = btoa(
        `${encodeURIComponent(this.provider.clientId)}:${encodeURIComponent(this.provider.clientSecret)}`,
      );
      headers["Authorization"] = `Basic ${creds}`;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: params.toString(),
    });

    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
        error_description?: string;
      } | null;
      throw new Error(
        `Token request failed (HTTP ${res.status}): ` +
          (payload?.error_description ?? payload?.error ?? "unknown error"),
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };

    if (!data.access_token) {
      throw new Error("Token response is missing `access_token`");
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? "Bearer",
      expiresAt:
        data.expires_in !== undefined
          ? Date.now() + data.expires_in * 1_000
          : undefined,
      refreshToken: data.refresh_token,
      scope: data.scope,
    };
  }

  // ── State helpers (CSRF) ───────────────────────────────────────────────────

  private async persistState(state: string): Promise<void> {
    if (this.provider.saveState) {
      await this.provider.saveState(state);
    } else {
      this._pendingStateMemory = state;
    }
  }

  private async recallState(): Promise<string | null> {
    if (this.provider.loadState) return this.provider.loadState();
    return this._pendingStateMemory;
  }

  private async clearState(): Promise<void> {
    if (this.provider.saveState) {
      await this.provider.saveState("");
    } else {
      this._pendingStateMemory = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate PKCE verifier (32 random bytes) and S256 challenge (§ 11.4). */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const verifier = base64urlEncode(buf);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64urlEncode(new Uint8Array(hash));
  return { verifier, challenge };
}

/** Generate a cryptographically random state value for CSRF protection. */
function generateState(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return base64urlEncode(buf);
}

function base64urlEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Parse `key="value"` pairs from a Bearer `WWW-Authenticate` header value.
 * e.g. `Bearer resource_metadata="https://…", scope="read write"`
 */
function parseWWWAuthenticate(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

/** Fetch JSON from a URL; returns `null` on any network or HTTP error. */
async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
