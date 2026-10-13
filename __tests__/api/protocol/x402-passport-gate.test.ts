import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { POST as postSettle } from '@/app/api/protocol/x402/settle/route'
import { createX402Quote } from '@/lib/protocols/x402'
import { savePassport, type AgentPassport } from '@/lib/passport/passport'

const testAgentId = 'passport-gate-test-agent'
const collectionKey = `open-stellar:passport-collection:testnet:${testAgentId}`

// Mock localStorage for Node environment
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

function createTestQuote(overrides: Record<string, unknown> = {}) {
  return createX402Quote({
    serviceId: 'passport-gate-service',
    chain: 'stellar',
    payer: testAgentId,
    units: 1,
    unitPriceUsd: 0.1,
    ttlSeconds: 300,
    ...overrides,
  })
}

function createTestPassport(spendCap: string): AgentPassport {
  return {
    id: `passport-${Date.now()}`,
    agentId: testAgentId,
    spendCap,
    registryRoot: '0x' + 'a'.repeat(64),
    nullifierHash: '0x' + 'b'.repeat(64),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'ACTIVE',
    network: 'testnet',
  }
}

beforeEach(() => {
  // Setup localStorage mock
  vi.stubGlobal('localStorage', localStorageMock)
  // Clear localStorage before each test
  localStorageMock.removeItem(collectionKey)
})

afterEach(() => {
  // Clean up after each test
  localStorageMock.removeItem(collectionKey)
  vi.unstubAllGlobals()
})

describe('POST /api/protocol/x402/settle with passport gate', () => {
  it('rejects settlement when agentId is provided but passport does not exist', async () => {
    const quote = createTestQuote()
    const mockTxHash = `0x${'a'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(402)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/passport/i)
    expect(data.gate).toBeDefined()
    expect(data.gate.authorized).toBe(false)
  })

  it('rejects settlement when payment amount exceeds passport spend cap', async () => {
    // Create a passport with low spend cap
    const passport = createTestPassport('1000000') // 0.1 XLM
    savePassport(passport)

    // Create a quote that requires more than the cap
    const quote = createTestQuote({ unitPriceUsd: 1.0 }) // Higher price
    const mockTxHash = `0x${'b'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(402)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/passport/i)
    expect(data.gate).toBeDefined()
    expect(data.gate.authorized).toBe(false)
    expect(data.gate.reason).toMatch(/exceeds/i)
  })

  it('approves settlement when payment amount is within passport spend cap', async () => {
    // Create a passport with sufficient spend cap
    const passport = createTestPassport('100000000') // 10 XLM
    savePassport(passport)

    const quote = createTestQuote({ unitPriceUsd: 0.1 })
    const mockTxHash = `0x${'c'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.receipt).toBeDefined()
    expect(data.receipt.accepted).toBe(true)
  })

  it('allows settlement without passport gate when agentId is not provided', async () => {
    const quote = createTestQuote({ payer: 'anonymous' })
    const mockTxHash = `0x${'d'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        paidBy: 'anonymous',
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.receipt).toBeDefined()
    expect(data.receipt.accepted).toBe(true)
  })

  it('rejects settlement with expired passport', async () => {
    // Create an expired passport
    const passport: AgentPassport = {
      ...createTestPassport('100000000'),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // Expired yesterday
    }
    savePassport(passport)

    const quote = createTestQuote()
    const mockTxHash = `0x${'e'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(402)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/passport/i)
  })

  it('rejects settlement with revoked passport', async () => {
    // Create a revoked passport
    const passport: AgentPassport = {
      ...createTestPassport('100000000'),
      status: 'REVOKED',
    }
    savePassport(passport)

    const quote = createTestQuote()
    const mockTxHash = `0x${'f'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(402)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/passport/i)
  })

  it('includes spend cap in response when passport gate is triggered', async () => {
    const passport = createTestPassport('5000000') // 0.5 XLM
    savePassport(passport)

    const quote = createTestQuote({ unitPriceUsd: 1.0 })
    const mockTxHash = `0x${'1'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: quote.paymentRef,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(data.gate).toBeDefined()
    expect(data.gate.cap).toBe('5000000')
  })

  it('handles quoteId instead of paymentRef with passport gate', async () => {
    const passport = createTestPassport('100000000')
    savePassport(passport)

    const quote = createTestQuote()
    const mockTxHash = `0x${'2'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        quoteId: quote.quoteId,
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.receipt).toBeDefined()
  })

  it('rejects settlement when quote is not found for agentId settlement', async () => {
    const passport = createTestPassport('100000000')
    savePassport(passport)

    const mockTxHash = `0x${'3'.repeat(64)}`

    const req = new Request('http://localhost/api/protocol/x402/settle', {
      method: 'POST',
      body: JSON.stringify({
        paymentRef: 'nonexistent:payment:ref',
        chain: 'stellar',
        txHash: mockTxHash,
        agentId: testAgentId,
      }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await postSettle(req)
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/quote not found/i)
  })
})
