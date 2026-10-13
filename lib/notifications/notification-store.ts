import { isNotificationTypeMuted } from "@/lib/notifications/notification-preferences"

export const NOTIFICATION_TYPES = ["agent_offline", "quest_completed", "reputation_updated", "quest_expired"] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

export interface NotificationRecord {
  id: string
  cursor: string
  agentId: string
  type: NotificationType
  title: string
  body: string
  resourceHref: string
  resourceLabel: string
  createdAt: string
  readAt: string | null
  dedupeKey?: string
  questId?: string
  expiresAt?: string
  remainingMs?: number
}

export interface AddNotificationInput {
  agentId: string
  type: NotificationType
  title?: string
  body?: string
  resourceHref?: string
  resourceLabel?: string
  createdAt?: string
  dedupeKey?: string
  questId?: string
  expiresAt?: string
  remainingMs?: number
}

export interface ListNotificationsOptions {
  since?: string | null
  limit?: number
}

type NotificationStore = Map<string, NotificationRecord[]>

const MAX_NOTIFICATIONS_PER_AGENT = 50
const DEFAULT_NOTIFICATION_LIMIT = 20

const globalNotifications = globalThis as typeof globalThis & {
  __notificationStore__?: NotificationStore
  __notificationCursor__?: number
}

const store: NotificationStore = globalNotifications.__notificationStore__ ?? new Map()
if (!globalNotifications.__notificationStore__) {
  globalNotifications.__notificationStore__ = store
}

if (typeof globalNotifications.__notificationCursor__ !== "number") {
  globalNotifications.__notificationCursor__ = 0
}

function nextCursor(): string {
  globalNotifications.__notificationCursor__ = (globalNotifications.__notificationCursor__ ?? 0) + 1
  return String(globalNotifications.__notificationCursor__)
}

function clampLimit(limit: number | undefined, fallback = DEFAULT_NOTIFICATION_LIMIT): number {
  if (!Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(MAX_NOTIFICATIONS_PER_AGENT, Math.floor(Number(limit))))
}

function agentNotifications(agentId: string): NotificationRecord[] {
  const cleanId = agentId.trim()
  if (!cleanId) return []
  const existing = store.get(cleanId)
  if (existing) return existing
  const created: NotificationRecord[] = []
  store.set(cleanId, created)
  return created
}

export function addNotification(input: AddNotificationInput): NotificationRecord | null {
  const agentId = input.agentId.trim()
  if (!agentId) throw new Error("agentId is required")
  if (isNotificationTypeMuted(agentId, input.type)) return null

  const notifications = agentNotifications(agentId)
  if (input.dedupeKey) {
    const duplicate = notifications.find(
      (notification) => notification.type === input.type && notification.dedupeKey === input.dedupeKey,
    )
    if (duplicate) return duplicate
  }

  const cursor = nextCursor()
  const title = input.title ?? (input.type === "quest_expired" ? "Quest expiring soon" : "Notification")
  const body = input.body ?? (input.type === "quest_expired" ? `Quest "${input.questId ?? ""}" is expiring soon.` : "")
  const resourceHref = input.resourceHref ?? (input.questId ? `/?quest=${encodeURIComponent(input.questId)}` : "/")
  const resourceLabel = input.resourceLabel ?? input.questId ?? "Quest"

  const notification: NotificationRecord = {
    id: `${agentId}-${cursor}`,
    cursor,
    agentId,
    type: input.type,
    title,
    body,
    resourceHref,
    resourceLabel,
    createdAt: input.createdAt ?? new Date().toISOString(),
    readAt: null,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.questId ? { questId: input.questId } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.remainingMs !== undefined ? { remainingMs: input.remainingMs } : {}),
  }

  notifications.push(notification)
  if (notifications.length > MAX_NOTIFICATIONS_PER_AGENT) {
    notifications.splice(0, notifications.length - MAX_NOTIFICATIONS_PER_AGENT)
  }

  return notification
}

export function listUnseenNotifications(
  agentId: string,
  options: ListNotificationsOptions = {},
): NotificationRecord[] {
  const sinceCursor = Number(options.since ?? 0)
  const hasSince = Number.isFinite(sinceCursor) && sinceCursor > 0
  const limit = clampLimit(options.limit)

  return (store.get(agentId.trim()) ?? [])
    .filter((notification) => notification.readAt === null)
    .filter((notification) => !hasSince || Number(notification.cursor) > sinceCursor)
    .slice()
    .reverse()
    .slice(0, limit)
}

export function getUnreadNotificationCount(agentId: string): number {
  return (store.get(agentId.trim()) ?? []).filter((notification) => notification.readAt === null).length
}

export function markAllNotificationsRead(agentId: string, readAt = new Date().toISOString()): number {
  let markedRead = 0
  for (const notification of store.get(agentId.trim()) ?? []) {
    if (notification.readAt === null) {
      notification.readAt = readAt
      markedRead += 1
    }
  }
  return markedRead
}

export function markNotificationRead(
  agentId: string,
  notificationId: string,
  readAt = new Date().toISOString(),
): boolean {
  const cleanAgentId = agentId.trim()
  const cleanNotifId = notificationId.trim()
  const notifications = store.get(cleanAgentId) ?? []
  const notif = notifications.find(
    (n) => n.id === cleanNotifId || n.id === `${cleanAgentId}-${cleanNotifId}` || n.cursor === cleanNotifId,
  )
  if (!notif) return false
  notif.readAt = readAt
  return true
}

export function listNotifications(
  agentId: string,
  options: { type?: NotificationType; unreadOnly?: boolean; since?: string | null; limit?: number } = {},
): NotificationRecord[] {
  const cleanAgentId = agentId.trim()
  const list = store.get(cleanAgentId) ?? []
  return list
    .filter((n) => (!options.type || n.type === options.type))
    .filter((n) => (options.unreadOnly ? n.readAt === null : true))
    .slice()
    .reverse()
}

export function resetNotificationStore(): void {
  store.clear()
  globalNotifications.__notificationCursor__ = 0
}
