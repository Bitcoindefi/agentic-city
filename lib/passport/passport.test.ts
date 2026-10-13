import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { authorizePayment, loadPassportCollection, savePassport, type AgentPassport } from './passport'

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

describe('passport authorizePayment gate', () => {
  const testAgentId = 'test-agent-123'
  const collectionKey = `open-stellar:passport-collection:testnet:${testAgentId}`

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

  it('rejects payment when agent has no passport', async () => {
    const result = await authorizePayment(testAgentId, '10000000')

    expect(result.authorized).toBe(false)
    expect(result.reason).toBe('No active passport — agent not verified')
    expect(result.cap).toBeUndefined()
  })

  it('rejects payment when amount exceeds spend cap', async () => {
    const passport: AgentPassport = {
      id: 'test-passport-1',
      agentId: testAgentId,
      spendCap: '10000000', // 1 XLM (7 decimals)
      registryRoot: '0x' + 'a'.repeat(64),
      nullifierHash: '0x' + 'b'.repeat(64),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      network: 'testnet',
    }

    savePassport(passport)

    const result = await authorizePayment(testAgentId, '20000000') // 2 XLM

    expect(result.authorized).toBe(false)
    expect(result.reason).toBe('Exceeds proven spend cap')
    expect(result.cap).toBe('10000000')
  })

  it('approves payment when amount is within spend cap', async () => {
    const passport: AgentPassport = {
      id: 'test-passport-2',
      agentId: testAgentId,
      spendCap: '10000000', // 1 XLM
      registryRoot: '0x' + 'c'.repeat(64),
      nullifierHash: '0x' + 'd'.repeat(64),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      network: 'testnet',
    }

    savePassport(passport)

    const result = await authorizePayment(testAgentId, '5000000') // 0.5 XLM

    expect(result.authorized).toBe(true)
    expect(result.reason).toBe('Within proven spend cap')
    expect(result.cap).toBe('10000000')
  })

  it('approves payment when amount exactly equals spend cap', async () => {
    const passport: AgentPassport = {
      id: 'test-passport-3',
      agentId: testAgentId,
      spendCap: '10000000',
      registryRoot: '0x' + 'e'.repeat(64),
      nullifierHash: '0x' + 'f'.repeat(64),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      network: 'testnet',
    }

    savePassport(passport)

    const result = await authorizePayment(testAgentId, '10000000')

    expect(result.authorized).toBe(true)
    expect(result.reason).toBe('Within proven spend cap')
    expect(result.cap).toBe('10000000')
  })

  it('rejects payment when passport is expired', async () => {
    const passport: AgentPassport = {
      id: 'test-passport-4',
      agentId: testAgentId,
      spendCap: '10000000',
      registryRoot: '0x' + '1'.repeat(64),
      nullifierHash: '0x' + '2'.repeat(64),
      issuedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), // Expired yesterday
      status: 'ACTIVE',
      network: 'testnet',
    }

    savePassport(passport)

    const result = await authorizePayment(testAgentId, '5000000')

    // Expired passports are not considered active
    expect(result.authorized).toBe(false)
    expect(result.reason).toBe('No active passport — agent not verified')
  })

  it('rejects payment when passport is revoked', async () => {
    const passport: AgentPassport = {
      id: 'test-passport-5',
      agentId: testAgentId,
      spendCap: '10000000',
      registryRoot: '0x' + '3'.repeat(64),
      nullifierHash: '0x' + '4'.repeat(64),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'REVOKED',
      network: 'testnet',
    }

    savePassport(passport)

    const result = await authorizePayment(testAgentId, '5000000')

    expect(result.authorized).toBe(false)
    expect(result.reason).toBe('No active passport — agent not verified')
  })

  it('handles zero amount correctly', async () => {
    const passport: AgentPassport = {
      id: 'test-passport-6',
      agentId: testAgentId,
      spendCap: '10000000',
      registryRoot: '0x' + '5'.repeat(64),
      nullifierHash: '0x' + '6'.repeat(64),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      network: 'testnet',
    }

    savePassport(passport)

    const result = await authorizePayment(testAgentId, '0')

    expect(result.authorized).toBe(true)
    expect(result.reason).toBe('Within proven spend cap')
  })

  it('uses primary passport when multiple passports exist', async () => {
    const passport1: AgentPassport = {
      id: 'test-passport-7',
      agentId: testAgentId,
      spendCap: '5000000', // 0.5 XLM
      registryRoot: '0x' + '7'.repeat(64),
      nullifierHash: '0x' + '8'.repeat(64),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      network: 'testnet',
    }

    const passport2: AgentPassport = {
      id: 'test-passport-8',
      agentId: testAgentId,
      spendCap: '10000000', // 1 XLM
      registryRoot: '0x' + '9'.repeat(64),
      nullifierHash: '0x' + 'a'.repeat(63) + 'b',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE',
      network: 'testnet',
    }

    // Save both passports
    savePassport(passport1)
    const collection = savePassport(passport2)

    // Set passport2 as primary
    collection.primaryPassport = passport2.id
    localStorageMock.setItem(collectionKey, JSON.stringify(collection))

    const result = await authorizePayment(testAgentId, '7500000') // 0.75 XLM

    // Should use passport2 (1 XLM cap) which can cover 0.75 XLM
    expect(result.authorized).toBe(true)
    expect(result.cap).toBe('10000000')
  })
})
