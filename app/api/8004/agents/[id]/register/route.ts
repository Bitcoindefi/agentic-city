import { NextResponse } from "next/server"
import { getClientIp } from "@/lib/auth/middleware"
import { isStrictSameOrigin } from "@/lib/connections/hydrate"
import { serializeCookie, type CookieWrite } from "@/lib/connections/sealed-cookie"
import { ensureBrowserId } from "@/lib/identity/browser-id"
import { recordReceipt } from "@/lib/receipts/log"
import { IdentityError, registerAgentIdentity } from "@/lib/solana/agent-identity"
import { browserOwner, resolveAgentOwner, type AgentOwner } from "@/lib/solana/agent-owner"
import { REGISTRATION_LIMITS, reserveRegistration } from "@/lib/solana/registration-quota"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

type RouteContext = { params: Promise<{ id: string }> }

function json(body: Record<string, unknown>, status = 200, cookie: CookieWrite | null = null, req?: Request) {
  const response = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
  if (cookie && req) response.headers.append("Set-Cookie", serializeCookie(req, cookie))
  return response
}

/** The owner: the Google account when signed in, else this browser's id (created on first use). */
async function ownerFor(req: Request): Promise<{ owner: AgentOwner | null; cookie: CookieWrite | null }> {
  const signedIn = await resolveAgentOwner(req)
  if (signedIn) return { owner: signedIn, cookie: null }
  const browser = ensureBrowserId(req)
  if (!browser) return { owner: null, cookie: null }
  return { owner: browserOwner(browser.id), cookie: browser.cookie }
}

// Registers the agent's identity, paid by the treasury. No sign-in: the owner is this browser
// (or the Google account, for people who chose to sign in). Abuse is bounded by strict
// same-origin, a daily quota per owner and per IP, and a global daily cap kept in the shared
// store, so nobody can drain the treasury by clearing cookies.
export async function POST(req: Request, context: RouteContext) {
  if (!isStrictSameOrigin(req)) return json({ ok: false, error: "Cross-site requests are not allowed." }, 403)
  const { owner, cookie } = await ownerFor(req)
  if (!owner) return json({ ok: false, error: "Agent registration is not configured on this server." }, 503)
  const reply = (body: Record<string, unknown>, status = 200) => json(body, status, cookie, req)

  const { id } = await context.params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 40) : decodeURIComponent(id)
  const model = typeof body.model === "string" ? body.model.trim().slice(0, 60) : ""
  const role = typeof body.role === "string" ? body.role.trim().slice(0, 180) : ""

  let reservation: Awaited<ReturnType<typeof reserveRegistration>>
  try {
    reservation = await reserveRegistration(owner.tag, getClientIp(req))
  } catch (error) {
    console.error("[8004] registration quota unavailable:", error instanceof Error ? error.message : error)
    return reply({ ok: false, error: "Registration is unavailable right now. Try again later." }, 503)
  }
  if (!reservation.ok) {
    return reply({
      ok: false,
      error: reservation.scope === "global"
        ? "Too many registrations today. Try again tomorrow."
        : `You can register up to ${reservation.scope === "ip" ? REGISTRATION_LIMITS.perIpPerDay : REGISTRATION_LIMITS.perOwnerPerDay} agents per day.`,
    }, 429)
  }

  try {
    const result = await registerAgentIdentity({ id: decodeURIComponent(id), name, role, model, ownerTag: owner.tag }, new URL(req.url).origin)
    if (result.alreadyRegistered) await reservation.release()
    else if (result.signature) {
      // Public receipts log (best-effort, never throws). The treasury paid; no owner id goes in.
      await recordReceipt({ type: "registration", tx: result.signature, agentId: decodeURIComponent(id), agentName: name, identity: result.asset })
    }
    return reply({ ok: true, ...result })
  } catch (error) {
    await reservation.release().catch(() => undefined)
    const status = error instanceof IdentityError ? error.status : 502
    const message = error instanceof Error ? error.message : ""
    if (/insufficient|0x1\b|lamports/i.test(message)) return reply({ ok: false, error: "The treasury has no devnet SOL to pay for registration." }, status)
    if (!(error instanceof IdentityError)) console.error("[8004] registration failed:", message)
    return reply({ ok: false, error: error instanceof IdentityError ? message : "Registration failed. Try again later." }, status)
  }
}
