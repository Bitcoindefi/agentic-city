import { DISTRICTS, createAgents } from '@/lib/data'
import type { DistrictId } from '@/lib/types'
import { STELLAR_ENABLED } from '@/lib/config/chains'
import { getRobotStillPath } from '@/lib/robot-sprites'

export type ServiceCapability = 'data' | 'comms' | 'processing' | 'defense' | 'research'
export type ServiceStatus = 'online' | 'offline'

export interface MarketplaceService {
  id: string
  name: string
  description: string
  providerAgent: {
    id: string
    name: string
    sprite: string
    color: string
  }
  priceXlm: number
  district: DistrictId
  capabilityTags: ServiceCapability[]
  status: ServiceStatus
  totalCalls: number
  averageResponseMs: number
  rating: number
  reputationScore: number
  docs: string[]
  exampleRequest: Record<string, unknown>
  exampleResponse: Record<string, unknown>
  receiptHistory: Array<{ id: string; agent: string; amountXlm: number; settledAt: string; latencyMs: number }>
  uptime: Array<{ label: string; value: number }>
}

const baseServices: Array<Omit<MarketplaceService, 'providerAgent'>> = [
  {
    id: 'stellar-price-oracle',
    // The id stays stable for existing links; the public copy follows the chain flag.
    name: STELLAR_ENABLED ? 'Stellar Price Oracle' : 'Solana Price Oracle',
    description: STELLAR_ENABLED
      ? 'Low-latency XLM, stablecoin, and liquidity pool quotes for agent payment decisions.'
      : 'Low-latency SOL, stablecoin, and liquidity pool quotes for agent payment decisions.',
    priceXlm: 0.08,
    district: 'data-center',
    capabilityTags: ['data', 'research'],
    status: 'online',
    totalCalls: 18420,
    averageResponseMs: 142,
    rating: 4.9,
    reputationScore: 930,
    docs: [`Request normalized market snapshots for ${STELLAR_ENABLED ? 'Stellar' : 'Solana'} assets.`, 'Responses include freshness metadata and x402 receipt references.'],
    exampleRequest: { pair: STELLAR_ENABLED ? 'XLM/USDC' : 'SOL/USDC', horizon: '5m', includeDepth: true },
    exampleResponse: STELLAR_ENABLED
      ? { pair: 'XLM/USDC', mid: '0.1241', confidence: 0.98, receiptRequired: true }
      : { pair: 'SOL/USDC', mid: '152.40', confidence: 0.98, receiptRequired: true },
    receiptHistory: [
      { id: 'rcpt_oracle_1042', agent: 'bot-0', amountXlm: 0.08, settledAt: '2026-06-25T15:22:11Z', latencyMs: 128 },
      { id: 'rcpt_oracle_1041', agent: 'bot-8', amountXlm: 0.08, settledAt: '2026-06-25T14:47:02Z', latencyMs: 151 },
    ],
    uptime: [{ label: 'Mon', value: 99.9 }, { label: 'Tue', value: 99.8 }, { label: 'Wed', value: 100 }, { label: 'Thu', value: 99.7 }, { label: 'Fri', value: 99.9 }],
  },
  {
    id: 'packet-relay-mesh',
    name: 'Packet Relay Mesh',
    description: 'Encrypted comms relay for cross-district agent notifications, webhooks, and callbacks.',
    priceXlm: 0.03,
    district: 'comm-hub',
    capabilityTags: ['comms'],
    status: 'online',
    totalCalls: 27110,
    averageResponseMs: 88,
    rating: 4.7,
    reputationScore: 884,
    docs: ['POST a message envelope and receive delivery attestations.', 'Supports idempotency keys for retry-safe agent workflows.'],
    exampleRequest: { to: 'agent://research-lab/prism-4', topic: 'receipt.ready', body: { id: 'rcpt_123' } },
    exampleResponse: { delivered: true, hops: 3, ack: 'ack_9f3c' },
    receiptHistory: [
      { id: 'rcpt_relay_778', agent: 'bot-1', amountXlm: 0.03, settledAt: '2026-06-25T13:18:44Z', latencyMs: 83 },
      { id: 'rcpt_relay_777', agent: 'bot-6', amountXlm: 0.03, settledAt: '2026-06-25T12:51:30Z', latencyMs: 91 },
    ],
    uptime: [{ label: 'Mon', value: 99.5 }, { label: 'Tue', value: 99.7 }, { label: 'Wed', value: 99.4 }, { label: 'Thu', value: 99.9 }, { label: 'Fri', value: 99.6 }],
  },
  {
    id: 'batch-inference-forge',
    name: 'Batch Inference Forge',
    description: 'Queue-backed processing service for embeddings, classification, and summarization jobs.',
    priceXlm: 0.22,
    district: 'processing',
    capabilityTags: ['processing', 'data'],
    status: 'online',
    totalCalls: 9320,
    averageResponseMs: 640,
    rating: 4.8,
    reputationScore: 902,
    docs: ['Submit compact JSONL batches for deterministic inference.', 'Each job returns per-item usage and receipt IDs.'],
    exampleRequest: { task: 'summarize', inputs: ['receipt one', 'receipt two'], maxTokens: 120 },
    exampleResponse: { jobId: 'job_bif_41', status: 'complete', outputs: ['2 receipt summaries'] },
    receiptHistory: [
      { id: 'rcpt_forge_512', agent: 'bot-2', amountXlm: 0.22, settledAt: '2026-06-25T11:05:21Z', latencyMs: 611 },
      { id: 'rcpt_forge_511', agent: 'bot-7', amountXlm: 0.22, settledAt: '2026-06-25T10:48:56Z', latencyMs: 672 },
    ],
    uptime: [{ label: 'Mon', value: 98.9 }, { label: 'Tue', value: 99.1 }, { label: 'Wed', value: 99.4 }, { label: 'Thu', value: 99.2 }, { label: 'Fri', value: 99.3 }],
  },
  {
    id: 'threat-sentinel',
    name: 'Threat Sentinel',
    description: 'Defense scoring for URLs, wallets, payloads, and suspicious agent behavior.',
    priceXlm: 0.15,
    district: 'defense',
    capabilityTags: ['defense', 'data'],
    status: 'online',
    totalCalls: 12004,
    averageResponseMs: 214,
    rating: 4.9,
    reputationScore: 948,
    docs: ['Score risk before agents settle payments or execute callbacks.', 'Returns explainable signals and recommended policy actions.'],
    exampleRequest: { wallet: 'G...', url: 'https://example.com/callback', action: 'settle' },
    exampleResponse: { risk: 'low', score: 12, action: 'allow', signals: ['known-counterparty'] },
    receiptHistory: [
      { id: 'rcpt_sentinel_901', agent: 'bot-3', amountXlm: 0.15, settledAt: '2026-06-25T09:12:37Z', latencyMs: 205 },
      { id: 'rcpt_sentinel_900', agent: 'bot-9', amountXlm: 0.15, settledAt: '2026-06-25T08:57:10Z', latencyMs: 226 },
    ],
    uptime: [{ label: 'Mon', value: 100 }, { label: 'Tue', value: 99.9 }, { label: 'Wed', value: 99.8 }, { label: 'Thu', value: 100 }, { label: 'Fri', value: 99.9 }],
  },
  {
    id: 'paper-trail-research',
    name: 'Paper Trail Research',
    description: 'Research assistant API that extracts claims, citations, and experiment plans from documents.',
    priceXlm: 0.18,
    district: 'research',
    capabilityTags: ['research', 'processing'],
    status: 'offline',
    totalCalls: 6740,
    averageResponseMs: 980,
    rating: 4.5,
    reputationScore: 801,
    docs: ['Upload text or URLs to produce structured research notes.', 'Offline while the provider rotates index shards.'],
    exampleRequest: { url: 'https://arxiv.org/abs/example', extract: ['claims', 'methods'] },
    exampleResponse: { claims: 8, citations: 31, replicationChecklist: ['dataset', 'metrics'] },
    receiptHistory: [
      { id: 'rcpt_paper_219', agent: 'bot-4', amountXlm: 0.18, settledAt: '2026-06-24T22:33:08Z', latencyMs: 944 },
      { id: 'rcpt_paper_218', agent: 'bot-10', amountXlm: 0.18, settledAt: '2026-06-24T21:14:50Z', latencyMs: 1001 },
    ],
    uptime: [{ label: 'Mon', value: 99.0 }, { label: 'Tue', value: 98.7 }, { label: 'Wed', value: 97.8 }, { label: 'Thu', value: 96.2 }, { label: 'Fri', value: 94.5 }],
  },
]

export function listMarketplaceServices(): MarketplaceService[] {
  const agents = createAgents()
  return baseServices.map((service, index) => {
    const agent = agents.find((candidate) => candidate.district === service.district) ?? agents[index]
    return {
      ...service,
      providerAgent: {
        id: agent.id,
        name: agent.name,
        sprite: getRobotStillPath(agent.district),
        color: agent.color,
      },
    }
  })
}

export function getMarketplaceService(serviceId: string): MarketplaceService | undefined {
  return listMarketplaceServices().find((service) => service.id === serviceId)
}

export function getDistrictName(districtId: DistrictId): string {
  return DISTRICTS.find((district) => district.id === districtId)?.name ?? districtId
}
