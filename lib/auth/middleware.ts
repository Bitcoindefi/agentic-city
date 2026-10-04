import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  checkTierRateLimit,
  verifyApiKey,
  type ApiKeyTier,
  type VerificationResult,
} from "./api-keys";
import { getAdminSessionTokenFromRequest, getSessionAdminApiKey, isAdminSessionToken } from "./admin-session";

export interface AuthEvaluationResult {
  allowed: boolean;
  status: number;
  error?: string;
  tier: ApiKeyTier;
  scopes: string[];
  isAdmin: boolean;
  headers?: Record<string, string>;
}

/**
 * Extracts API key from Authorization header (Bearer osk_live_...) or x-api-key header.
 * Query parameter API keys are intentionally unsupported to prevent leakage in access logs and URL history.
 */
export function extractApiKey(req: Request | NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const key = authHeader.slice(7).trim();
    if (key) return key;
  }

  const customHeader = req.headers.get("x-api-key");
  if (customHeader?.trim()) {
    return customHeader.trim();
  }

  return null;
}

/**
 * Normalises an IP string for safe comparison:
 * - Lowercases (IPv6 hex digits can be upper-case: FE80::1)
 * - Strips IPv6 bracket+port suffix: [::1]:80 → ::1
 * - Strips IPv4 port suffix: 1.2.3.4:8080 → 1.2.3.4
 */
function normalizeIp(ip: string): string {
  const t = ip.trim().toLowerCase();
  // IPv6 bracket-port: [fe80::1]:80
  if (t.startsWith("[")) {
    const bracket = t.indexOf("]");
    return bracket !== -1 ? t.slice(1, bracket) : t;
  }
  // IPv4 with port: 1.2.3.4:443 — only strip if there is exactly one colon
  const colonCount = (t.match(/:/g) || []).length;
  if (colonCount === 1) {
    return t.split(":")[0]!;
  }
  return t;
}

/**
 * Checks if an IP is a known internal/loopback/private network address.
 * Always call with a normalised (lowercase, port-stripped) IP.
 */
function isPrivateOrProxyIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (
    n === "127.0.0.1" ||
    n === "::1" ||
    n === "localhost" ||
    n.startsWith("10.") ||
    n.startsWith("192.168.") ||
    n.startsWith("169.254.") ||
    n.startsWith("fc00:") ||
    n.startsWith("fe80:")
  ) {
    return true;
  }
  if (n.startsWith("172.")) {
    const parts = n.split(".");
    const second = Number.parseInt(parts[1] || "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Robust client IP extraction.
 *
 * Priority order:
 *   1. `cf-connecting-ip`: ONLY when TRUST_CF_CONNECTING_IP=true (the app really sits
 *      behind Cloudflare). On Vercel a client can send this header itself, so it is ignored
 *      by default.
 *   2. `x-real-ip`: overwritten by Vercel (and Nginx-style proxies) with the client IP.
 *   3. `x-vercel-forwarded-for`: first hop, set by Vercel.
 *   4. `x-forwarded-for` via TRUSTED_PROXY_COUNT strategy (Vercel overwrites it too):
 *      - If `TRUSTED_PROXY_COUNT` env var is set (e.g. "1" on Vercel), take
 *        the Nth-from-right entry where N = trustedProxyCount. This is safe
 *        because all N rightmost hops are added by your own infrastructure.
 *      - Otherwise fall back to the right-most non-private hop (best effort).
 */
export function getClientIp(req: Request | NextRequest): string {
  if (process.env.TRUST_CF_CONNECTING_IP === "true") {
    const cfConnectingIp = req.headers.get("cf-connecting-ip");
    if (cfConnectingIp?.trim()) {
      return normalizeIp(cfConnectingIp);
    }
  }

  const xRealIp = req.headers.get("x-real-ip");
  if (xRealIp?.trim()) {
    return normalizeIp(xRealIp);
  }

  const vercelForwardedFor = req.headers.get("x-vercel-forwarded-for");
  const vercelClientIp = vercelForwardedFor?.split(",")[0]?.trim();
  if (vercelClientIp) {
    return normalizeIp(vercelClientIp);
  }

  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const ips = xForwardedFor
      .split(",")
      .map((ip) => normalizeIp(ip))
      .filter(Boolean);

    // TRUSTED_PROXY_COUNT: when set, the infrastructure appended exactly that
    // many hops. Pick the entry immediately before those trusted hops.
    const trustedProxyCount = Number.parseInt(
      process.env.TRUSTED_PROXY_COUNT || "0",
      10,
    );
    if (trustedProxyCount > 0 && ips.length > 0) {
      const idx = Math.max(0, ips.length - 1 - trustedProxyCount);
      return ips[idx]!;
    }

    // Best-effort fallback: rightmost non-private hop.
    const clientIp = [...ips].reverse().find((ip) => !isPrivateOrProxyIp(ip));
    if (clientIp) return clientIp;
    if (ips.length > 0) return ips[0]!;
  }

  return "127.0.0.1";
}

/**
 * Static and framework asset allowlist
 */
export function isStaticOrInternalPath(pathname: string): boolean {
  return (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname.startsWith("/public") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/manifest.json" ||
    /\.(png|jpg|jpeg|gif|svg|ico|webp|css|js|woff|woff2|ttf|eot)$/i.test(
      pathname,
    )
  );
}

/**
 * Public UI Pages allowlist
 */
const PUBLIC_PAGE_PREFIXES = [
  "/explorer",
  "/feed",
  "/leaderboard",
  "/marketplace",
  "/districts",
  "/docs",
  "/agents",
  "/credential",
  "/legal",
  "/offline",
];

export function isPublicPage(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Public API Routes allowlist (Read-only endpoints, protocol negotiation, and public telemetry)
 */
export function isPublicApiRoute(pathname: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") {
    if (
      pathname === "/api/agents" ||
      pathname.startsWith("/api/agents/") ||
      pathname === "/api/feed" ||
      pathname === "/api/leaderboard" ||
      pathname === "/api/badges" ||
      pathname === "/api/skills" ||
      pathname.startsWith("/api/skills/") ||
      pathname === "/api/prices" ||
      pathname === "/api/events" ||
      pathname.startsWith("/api/events/") ||
      pathname.startsWith("/api/districts/") ||
      pathname.startsWith("/api/explorer/") ||
      pathname === "/api/receipts" ||
      pathname === "/api/openapi.json" ||
      pathname === "/api/webhooks/event-types" ||
      pathname === "/api/tasks" ||
      pathname.startsWith("/api/tasks/") ||
      pathname.startsWith("/api/tasks/dead-letter") ||
      pathname.startsWith("/api/protocol/passport/status") ||
      pathname.startsWith("/api/protocol/passport/health") ||
      pathname.startsWith("/api/protocol/reputation") ||
      pathname.startsWith("/api/protocol/track8004") ||
      pathname.startsWith("/api/protocol/x402/receipts") ||
      pathname.startsWith("/api/subscriptions/") ||
      pathname.startsWith("/api/stellar/balance") ||
      pathname === "/api/user/export" ||
      // User sign-in and login-based connections (no API keys involved).
      pathname.startsWith("/api/auth/") ||
      pathname === "/api/account" ||
      pathname === "/api/connections/openrouter" ||
      pathname === "/api/connections/openrouter/start" ||
      pathname === "/api/connections/openrouter/callback" ||
      // 8004 agent identity: status and registration files are public.
      pathname.startsWith("/api/8004/agents/") ||
      // This browser's agents' wallet (cookie-scoped, same-origin checked in the route).
      pathname === "/api/agent-wallet"
    ) {
      return true;
    }
  }

  // Public state machines and payment handshakes
  if (method === "POST") {
    if (
      pathname === "/api/protocol/x402/quote" ||
      pathname === "/api/protocol/x402/settle" ||
      pathname === "/api/protocol/passport/authorize" ||
      pathname === "/api/quests" ||
      pathname.startsWith("/api/quests/") ||
      // Bring-your-own-key relays: stateless, the caller supplies the provider key.
      pathname === "/api/connections/test" ||
      pathname === "/api/connections/chat" ||
      pathname === "/api/connections/run" ||
      pathname.startsWith("/api/auth/") ||
      // Paid agent tasks: access is granted by an x402 payment, not by an API key.
      /^\/api\/x402\/agents\/[^/]+\/task$/.test(pathname) ||
      // Registration is per browser (quota checked in the route); reviews need an x402 payment.
      /^\/api\/8004\/agents\/[^/]+\/(register|feedback)$/.test(pathname) ||
      // Fund (sponsored tx) and withdraw this browser's agents' wallet (cookie-scoped, strict same-origin in the routes).
      pathname === "/api/agent-wallet/withdraw" ||
      pathname === "/api/agent-wallet/fund"
    ) {
      return true;
    }
  }

  if (method === "DELETE" && pathname === "/api/connections/openrouter") {
    return true;
  }

  return false;
}

function evaluateAdminRoute(
  apiKey: string | null,
  authResult: VerificationResult,
  isDevBypass: boolean,
): AuthEvaluationResult {
  if (isDevBypass) {
    return {
      allowed: true,
      status: 200,
      tier: "admin",
      scopes: ["*"],
      isAdmin: true,
    };
  }

  if (!apiKey) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized: Admin API key required",
      tier: "no_key",
      scopes: [],
      isAdmin: false,
    };
  }

  if (!authResult.valid || !authResult.isAdmin) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized: Invalid or revoked API key",
      tier: "no_key",
      scopes: [],
      isAdmin: false,
    };
  }

  return {
    allowed: true,
    status: 200,
    tier: authResult.tier,
    scopes: authResult.scopes,
    isAdmin: true,
  };
}

/**
 * Unified evaluator for scoped state-mutating operations.
 */
function evaluateScopedWriteRoute(
  apiKey: string | null,
  authResult: VerificationResult,
  isDevBypass: boolean,
  requiredScope: string,
  resourceName: string,
): AuthEvaluationResult | null {
  if (isDevBypass) {
    return null;
  }

  if (!apiKey) {
    return {
      allowed: false,
      status: 401,
      error: `Unauthorized: API key required for ${resourceName}`,
      tier: "no_key",
      scopes: [],
      isAdmin: false,
    };
  }

  if (!authResult.valid) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized: Invalid or revoked API key",
      tier: "no_key",
      scopes: [],
      isAdmin: false,
    };
  }

  const hasRequiredScope =
    authResult.isAdmin ||
    authResult.scopes.includes("*") ||
    authResult.scopes.includes(requiredScope);

  if (!hasRequiredScope) {
    return {
      allowed: false,
      status: 403,
      error: `Forbidden: Missing required scope ${requiredScope}`,
      tier: authResult.tier,
      scopes: authResult.scopes,
      isAdmin: false,
    };
  }

  return null;
}

/**
 * Cheap reads the UI needs on every page load (who am I, what is connected). They don't count
 * against the anonymous budget, so a visitor reloading the page never sees a broken account panel.
 */
export function isRateLimitExempt(pathname: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname === "/api/account" || pathname === "/api/connections/openrouter" || pathname === "/api/auth/get-session";
}

/**
 * The no-login browser flow: this browser's agents' wallet, 8004 identity, paid agent tasks and the
 * agent chat. One person using it makes several calls a minute by design (a fund refreshes the
 * balance four times, a paid task is a 402 and then the paid retry, a review re-reads the identity),
 * so against the 10-a-minute anonymous API budget a visitor who funds, chats and pays in the same
 * minute got "rate_limit_exceeded" (seen in a real-browser run). These routes have their own
 * per-browser limits or need an x402 payment, so they share a separate, larger per-IP budget.
 */
export function isBrowserFlowRoute(pathname: string, method: string): boolean {
  if (method === "GET") return pathname === "/api/agent-wallet" || /^\/api\/8004\/agents\/[^/]+$/.test(pathname);
  if (method !== "POST") return false;
  return (
    pathname === "/api/agent-wallet/fund" ||
    pathname === "/api/agent-wallet/withdraw" ||
    pathname === "/api/connections/chat" ||
    /^\/api\/x402\/agents\/[^/]+\/task$/.test(pathname) ||
    /^\/api\/8004\/agents\/[^/]+\/(register|feedback)$/.test(pathname)
  );
}

function evaluateRateLimit(
  authResult: VerificationResult,
  clientIp: string,
): { allowed: boolean; status: number; headers: Record<string, string>; error?: string } {
  const rateLimitIdentifier =
    authResult.valid && authResult.record?.id ? authResult.record.id : clientIp;

  const rateLimitStatus = checkTierRateLimit(
    rateLimitIdentifier,
    authResult.tier,
  );

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(rateLimitStatus.limit),
    "X-RateLimit-Remaining": String(rateLimitStatus.remaining),
    "X-RateLimit-Reset": String(Math.ceil(rateLimitStatus.resetTimeMs / 1000)),
    "X-Api-Tier": authResult.tier,
  };

  if (!rateLimitStatus.allowed) {
    headers["Retry-After"] = String(rateLimitStatus.retryAfterSeconds);
    return {
      allowed: false,
      status: 429,
      error: "rate_limit_exceeded",
      headers,
    };
  }

  return {
    allowed: true,
    status: 200,
    headers,
  };
}

function evaluateStateMutatingRoutes(
  pathname: string,
  method: string,
  apiKey: string | null,
  authResult: VerificationResult,
  isDevBypass: boolean,
): AuthEvaluationResult | null {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!isMutating) return null;

  if (pathname === "/api/agents" || pathname.startsWith("/api/agents/")) {
    return evaluateScopedWriteRoute(
      apiKey,
      authResult,
      isDevBypass,
      "agents:write",
      "agent management",
    );
  }

  if (pathname === "/api/webhooks" || pathname.startsWith("/api/webhooks/")) {
    return evaluateScopedWriteRoute(
      apiKey,
      authResult,
      isDevBypass,
      "webhooks:manage",
      "webhook management",
    );
  }

  if (
    (pathname === "/api/quests" || pathname.startsWith("/api/quests/")) &&
    !pathname.includes("/apply")
  ) {
    return evaluateScopedWriteRoute(
      apiKey,
      authResult,
      isDevBypass,
      "quests:manage",
      "quest management",
    );
  }

  return null;
}

function evaluateClosedByDefault(
  pathname: string,
  method: string,
  apiKey: string | null,
  authResult: VerificationResult,
  isDevBypass: boolean,
): AuthEvaluationResult | null {
  const isPublic = isPublicPage(pathname) || isPublicApiRoute(pathname, method);
  if (isPublic || isDevBypass) return null;

  if (!apiKey) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized: API key required",
      tier: "no_key",
      scopes: [],
      isAdmin: false,
    };
  }

  if (!authResult.valid) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized: Invalid or revoked API key",
      tier: "no_key",
      scopes: [],
      isAdmin: false,
    };
  }

  return null;
}

/**
 * Core Auth and Rate Limiting Evaluator
 */
export async function evaluateAuth(
  req: Request | NextRequest,
): Promise<AuthEvaluationResult> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  const isAdminLogin = pathname === "/admin/login";
  const isAdminSessionEndpoint = pathname === "/api/admin/session";
  const sessionToken = getAdminSessionTokenFromRequest(req);
  const sessionKey = sessionToken && isAdminSessionToken(sessionToken)
    ? getSessionAdminApiKey()
    : null;
  const apiKey = extractApiKey(req) ?? sessionKey;
  const authResult = apiKey
    ? await verifyApiKey(apiKey)
    : {
        valid: false,
        tier: "no_key" as ApiKeyTier,
        scopes: [] as string[],
        isAdmin: false,
      };

  const clientIp = getClientIp(req);
  // Never let a public production deployment bypass admin authentication.
  const isDevBypass = process.env.NODE_ENV !== "production" && process.env.DEV_MODE?.trim().toLowerCase() === "true";

  // Rate Limiting Evaluation
  // Anonymous calls of the no-login browser flow get their own bucket, at the free-tier size.
  const browserFlow = !authResult.valid && isBrowserFlowRoute(pathname, method);
  const rateLimitEval = isRateLimitExempt(pathname, method)
    ? { allowed: true, status: 200, headers: {} as Record<string, string>, error: undefined }
    : browserFlow
      ? evaluateRateLimit({ ...authResult, tier: "free" }, `browser-flow:${clientIp}`)
      : evaluateRateLimit(authResult, clientIp);
  if (!rateLimitEval.allowed) {
    return {
      allowed: false,
      status: rateLimitEval.status,
      error: rateLimitEval.error,
      tier: authResult.tier,
      scopes: authResult.scopes,
      isAdmin: authResult.isAdmin,
      headers: rateLimitEval.headers,
    };
  }

  // The login page and session endpoint are intentionally public. Session creation
  // verifies an admin key server-side; all other admin routes stay protected.
  if (isAdminLogin || isAdminSessionEndpoint) {
    return {
      allowed: true,
      status: 200,
      tier: authResult.tier,
      scopes: authResult.scopes,
      isAdmin: authResult.isAdmin,
      headers: rateLimitEval.headers,
    };
  }

  // Admin Routes (Highest protection)
  const isAdminRoute =
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/");

  if (isAdminRoute) {
    const adminCheck = evaluateAdminRoute(apiKey, authResult, isDevBypass);
    return {
      ...adminCheck,
      headers: {
        ...rateLimitEval.headers,
        ...(adminCheck.headers || {}),
      },
    };
  }

  const writeCheck = evaluateStateMutatingRoutes(
    pathname,
    method,
    apiKey,
    authResult,
    isDevBypass,
  );
  if (writeCheck) {
    return {
      ...writeCheck,
      headers: {
        ...rateLimitEval.headers,
        ...(writeCheck.headers || {}),
      },
    };
  }

  const closedByDefaultCheck = evaluateClosedByDefault(
    pathname,
    method,
    apiKey,
    authResult,
    isDevBypass,
  );
  if (closedByDefaultCheck) {
    return {
      ...closedByDefaultCheck,
      headers: {
        ...rateLimitEval.headers,
        ...(closedByDefaultCheck.headers || {}),
      },
    };
  }

  return {
    allowed: true,
    status: 200,
    tier: authResult.tier,
    scopes: authResult.scopes,
    isAdmin: authResult.isAdmin,
    headers: rateLimitEval.headers,
  };
}

/**
 * Standard Next.js middleware handler for auth & rate limiting.
 */
export async function authMiddleware(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;

  if (isStaticOrInternalPath(pathname)) {
    return NextResponse.next();
  }

  const result = await evaluateAuth(req);

  if (!result.allowed) {
    if ((pathname === "/admin" || pathname.startsWith("/admin/")) && pathname !== "/admin/login") {
      const loginUrl = new URL("/admin/login", req.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json(
      { ok: false, error: result.error || "Unauthorized" },
      {
        status: result.status,
        headers: result.headers,
      },
    );
  }

  const response = NextResponse.next();

  if (result.headers) {
    for (const [key, val] of Object.entries(result.headers)) {
      response.headers.set(key, val);
    }
  }

  return response;
}
