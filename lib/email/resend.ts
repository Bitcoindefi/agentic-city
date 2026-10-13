import * as crypto from "node:crypto"
import * as React from "react"
import { Resend } from "resend"
import { PaymentReceiptEmail, type PaymentReceiptEmailProps } from "@/emails/payment-receipt"
import { LevelUpEmail, type LevelUpEmailProps } from "@/emails/level-up"
import { DisputeResolvedEmail, type DisputeResolvedEmailProps } from "@/emails/dispute-resolved"
import { WeeklySummaryEmail, type WeeklySummaryEmailProps } from "@/emails/weekly-summary"

export type EmailEventType = "paymentReceipt" | "agentLevelUp" | "badgeUnlocked" | "disputeResolved" | "weeklyReport"

export interface EmailPreferences {
  email: string
  events: Partial<Record<EmailEventType, boolean>>
  unsubscribed?: boolean
}

export interface BadgeUnlockedEmailInput {
  agentName: string
  badgeName: string
  badgeRarity?: string
  unsubscribeUrl: string
}

export interface SendEmailOptions<T> {
  to: string
  data: T
}

interface EmailState {
  preferences: Map<string, EmailPreferences>
}

const globalState = globalThis as typeof globalThis & { __openStellarEmailState__?: EmailState }
const emailState: EmailState = globalState.__openStellarEmailState__ ?? { preferences: new Map() }

if (!globalState.__openStellarEmailState__) {
  globalState.__openStellarEmailState__ = emailState
}


function fromAddress(): string {
  return process.env.EMAIL_FROM || "Open Stellar <noreply@open-stellar.xyz>"
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://open-stellar.xyz"
}

function unsubscribeSecret(): string {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.NEXTAUTH_SECRET || "open-stellar-email-dev-secret"
}

function signEmail(email: string): string {
  return crypto.createHmac("sha256", unsubscribeSecret()).update(email.toLowerCase()).digest("hex")
}

export function createUnsubscribeUrl(email: string): string {
  const url = new URL("/api/email/unsubscribe", appUrl())
  url.searchParams.set("email", email)
  url.searchParams.set("token", signEmail(email))
  return url.toString()
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = signEmail(email)
  if (expected.length !== token.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
}

export function saveEmailPreferences(preferences: EmailPreferences): EmailPreferences {
  const normalized = { ...preferences, email: preferences.email.toLowerCase() }
  emailState.preferences.set(normalized.email, normalized)
  return normalized
}

export function getEmailPreferences(email: string): EmailPreferences | undefined {
  return emailState.preferences.get(email.toLowerCase())
}

export function unsubscribeEmail(email: string): EmailPreferences {
  const normalizedEmail = email.toLowerCase()
  const current = emailState.preferences.get(normalizedEmail)
  const preferences = current
    ? { ...current, unsubscribed: true, events: {} }
    : { email: normalizedEmail, unsubscribed: true, events: {} }
  emailState.preferences.set(normalizedEmail, preferences)
  return preferences
}

async function sendReactEmail(subject: string, to: string, react: React.ReactNode) {
  if (!process.env.RESEND_API_KEY) {
    return { skipped: true, reason: "RESEND_API_KEY is not configured" }
  }

  const resend = new Resend(process.env.RESEND_API_KEY)

  const { data, error } = await resend.emails.send({
    from: fromAddress(),
    to,
    subject,
    react,
  })

  if (error) throw new Error(error.message)
  return { skipped: false, data }
}

export async function sendRawEmail(options: { to: string; subject: string; text: string; html: string }) {
  if (!process.env.RESEND_API_KEY) {
    return { skipped: true, reason: "RESEND_API_KEY is not configured" }
  }

  const resend = new Resend(process.env.RESEND_API_KEY)
  const { data, error } = await resend.emails.send({
    from: fromAddress(),
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html,
  })

  if (error) throw new Error(error.message)
  return { skipped: false, data }
}

function BadgeUnlockedEmail({ agentName, badgeName, badgeRarity, unsubscribeUrl }: BadgeUnlockedEmailInput) {
  return React.createElement(
    "div",
    { style: { fontFamily: "Arial, sans-serif", color: "#102033", lineHeight: 1.5 } },
    React.createElement("h1", null, `${agentName} unlocked ${badgeName}`),
    React.createElement("p", null, `${badgeRarity ? `${badgeRarity} badge` : "Badge"} unlocked on Open Stellar.`),
    React.createElement(
      "p",
      { style: { fontSize: 12, color: "#667085" } },
      "You are receiving this because badge notifications are enabled. ",
      React.createElement("a", { href: unsubscribeUrl }, "Unsubscribe"),
      ".",
    ),
  )
}

export async function paymentReceipt({ to, data }: SendEmailOptions<PaymentReceiptEmailProps>) {
  return sendReactEmail(`Receipt: ${data.amountXlm} XLM payment to ${data.agentName}`, to, React.createElement(PaymentReceiptEmail, data))
}

export async function agentLevelUp({ to, data }: SendEmailOptions<LevelUpEmailProps>) {
  return sendReactEmail(`🎉 ${data.agentName} reached Level ${data.level}!`, to, React.createElement(LevelUpEmail, data))
}

export async function badgeUnlocked({ to, data }: SendEmailOptions<BadgeUnlockedEmailInput>) {
  return sendReactEmail(`${data.agentName} unlocked ${data.badgeName}`, to, React.createElement(BadgeUnlockedEmail, data))
}

export async function disputeResolved({ to, data }: SendEmailOptions<DisputeResolvedEmailProps>) {
  return sendReactEmail(`Dispute ${data.escrowId} resolved`, to, React.createElement(DisputeResolvedEmail, data))
}

export async function weeklyReport({ to, data }: SendEmailOptions<WeeklySummaryEmailProps>) {
  return sendReactEmail(`Your Open Stellar week: ${data.totalTasks.toLocaleString()} tasks, ${data.totalXlmEarned} XLM earned`, to, React.createElement(WeeklySummaryEmail, data))
}

export const emails = {
  paymentReceipt,
  agentLevelUp,
  badgeUnlocked,
  disputeResolved,
  weeklyReport,
}
