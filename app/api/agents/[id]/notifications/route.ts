import { NextResponse } from "next/server"
import {
  listNotifications,
  listUnseenNotifications,
  getUnreadNotificationCount,
} from "@/lib/notifications/notification-store"

export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params
  const agentId = decodeURIComponent(id).trim()

  if (!agentId) {
    return NextResponse.json({ ok: false, error: "agentId is required" }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const type = searchParams.get("type")

  if (type === "quest_expired") {
    // Returns pending quest-expiry notifications for the agent:
    // [{ "questId": "...", "expiresAt": "...", "remainingMs": 82800000 }]
    const notifications = listNotifications(agentId, { type: "quest_expired", unreadOnly: true })
    const nowMs = Date.now()
    const warnings = notifications.map((n) => {
      const expiresAt = n.expiresAt ?? n.createdAt
      const remainingMs = n.remainingMs ?? Math.max(0, new Date(expiresAt).getTime() - nowMs)
      return {
        id: n.id,
        questId: n.questId ?? n.resourceLabel ?? n.id,
        expiresAt,
        remainingMs,
      }
    })
    return NextResponse.json(warnings)
  }

  const notifications = listUnseenNotifications(agentId, {
    since: searchParams.get("since"),
    limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
  })

  return NextResponse.json({
    ok: true,
    agentId,
    notifications,
    unreadCount: getUnreadNotificationCount(agentId),
    nextCursor: notifications[0]?.cursor ?? searchParams.get("since") ?? null,
  })
}
