import { NextResponse } from "next/server"
import { markNotificationRead } from "@/lib/notifications/notification-store"

export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ id: string; notificationId: string }>
}

export async function PATCH(req: Request, context: RouteContext) {
  const { id, notificationId } = await context.params
  const agentId = decodeURIComponent(id).trim()
  const notifId = decodeURIComponent(notificationId).trim()

  if (!agentId || !notifId) {
    return NextResponse.json(
      { ok: false, error: "agentId and notificationId are required" },
      { status: 400 },
    )
  }

  const success = markNotificationRead(agentId, notifId)
  if (!success) {
    return NextResponse.json(
      { ok: false, error: "Notification not found" },
      { status: 404 },
    )
  }

  return NextResponse.json({
    ok: true,
    agentId,
    notificationId: notifId,
    cleared: true,
    read: true,
  })
}
