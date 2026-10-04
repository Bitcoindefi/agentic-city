import Image from "next/image"
import Link from "next/link"
import { feedAgentUrl, feedEventUrl, type FeedEvent } from "@/lib/feed/activity-feed"

const KIND_COLORS: Record<FeedEvent["kind"], string> = {
  payment: "#34d399",
  "level-up": "#22d3ee",
  badge: "#a78bfa",
  district: "#fbbf24",
  task: "#60a5fa",
}

function relativeTime(iso: string) {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function FeedItem({ event, compact = false }: { event: FeedEvent; compact?: boolean }) {
  const accent = KIND_COLORS[event.kind]
  const sprite = event.spritePath

  return (
    <article
      data-kind={event.kind}
      style={{
        display: "grid",
        gridTemplateColumns: compact ? "32px 1fr" : "44px 1fr auto",
        gap: compact ? 10 : 14,
        alignItems: "center",
        border: "1px solid #1f2a44",
        borderLeft: `4px solid ${accent}`,
        borderRadius: 8,
        background: "rgba(15,23,42,0.88)",
        padding: compact ? 10 : 14,
      }}
    >
      <div
        style={{
          width: compact ? 32 : 44,
          height: compact ? 32 : 44,
          borderRadius: 8,
          border: "1px solid #2a3a52",
          background: "#07111f",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {sprite ? (
          <Image src={sprite} alt="" width={compact ? 28 : 38} height={compact ? 28 : 38} unoptimized style={{ objectFit: "contain" }} />
        ) : (
          <span style={{ color: accent, fontFamily: "monospace", fontSize: compact ? 14 : 18 }}>#</span>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Link
            href={feedEventUrl(event)}
            style={{
              color: "#e2e8f0",
              fontFamily: "monospace",
              fontWeight: 700,
              fontSize: compact ? 12 : 14,
              textDecoration: "none",
              lineHeight: 1.4,
            }}
          >
            {event.title}
          </Link>
          <span style={{ color: accent, fontFamily: "monospace", fontSize: 10, textTransform: "uppercase" }}>
            {event.highlight}
          </span>
        </div>
        <div style={{ color: "#94a3b8", fontSize: compact ? 11 : 12, lineHeight: 1.6, marginTop: 4 }}>
          {event.detail}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, color: "#64748b", fontFamily: "monospace", fontSize: 10 }}>
          {event.agentName && <Link href={feedAgentUrl(event)} style={{ color: "#67e8f9", textDecoration: "none" }}>{event.agentName}</Link>}
          {event.districtName && <span>{event.districtName}</span>}
          <time dateTime={event.occurredAt}>{relativeTime(event.occurredAt)}</time>
        </div>
      </div>

      {!compact && (
        <a
          href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(event.shareText)}&url=${encodeURIComponent(feedEventUrl(event))}`}
          style={{
            border: "1px solid #2a3a52",
            borderRadius: 6,
            color: "#94a3b8",
            padding: "8px 10px",
            fontFamily: "monospace",
            fontSize: 11,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Share
        </a>
      )}
    </article>
  )
}
