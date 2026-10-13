import { publishSystemEvent } from "@/lib/events/system-events"
import type { AgentStatus, DistrictId } from "@/lib/types"

export interface AgentX402Manifest {
  accepts: boolean
  pricePerTask?: string
}

export interface SkillRegistration {
  id: string
  version?: string
  minCallerVersion?: string
}

export interface AgentCapabilityManifest {
  agentId: string
  email?: string
  emailOptOut?: boolean
  model: string
  district: DistrictId
  capabilities: string[]
  skillVersions?: SkillRegistration[]
  dependencies?: string[]
  x402: AgentX402Manifest
  status: AgentStatus
  errorCount24h?: number
  degraded?: boolean
  endpoint: string
  registeredAt: string
  updatedAt: string
}

export interface AgentRegistryFilters {
  district?: string
  status?: string
  skill?: string
  capability?: string
}

export interface CapabilityCount {
  capability: string
  count: number
}

export type AgentRegistryChangeAction = "registered" | "updated" | "deregistered"

const DISTRICTS: DistrictId[] = ["data-center", "comm-hub", "processing", "defense", "research"]
const STATUSES: AgentStatus[] = ["active", "idle", "running", "working", "error", "offline", "stopped", "degraded"]

interface AgentRegistryState {
  agents: Map<string, AgentCapabilityManifest>
}

const globalState = globalThis as typeof globalThis & {
  __openStellarAgentRegistry__?: AgentRegistryState
}

const registry: AgentRegistryState = globalState.__openStellarAgentRegistry__ ?? {
  agents: new Map(),
}

if (!globalState.__openStellarAgentRegistry__) {
  globalState.__openStellarAgentRegistry__ = registry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeOptionalEmail(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const email = normalizeString(value, "email").toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("email must be a valid email address")
  }
  return email
}

function normalizeDistrict(value: unknown): DistrictId {
  const district = normalizeString(value, "district")
  if (!DISTRICTS.includes(district as DistrictId)) {
    throw new Error(`district must be one of: ${DISTRICTS.join(", ")}`)
  }
  return district as DistrictId
}

function normalizeStatus(value: unknown): AgentStatus {
  const status = normalizeString(value, "status")
  if (!STATUSES.includes(status as AgentStatus)) {
    throw new Error(`status must be one of: ${STATUSES.join(", ")}`)
  }
  return status as AgentStatus
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("capabilities must be an array")
  }

  const capabilities = value.map((capability, index) => normalizeString(capability, `capabilities[${index}]`))
  return Array.from(new Set(capabilities))
}

function normalizeSkillVersions(value: unknown): SkillRegistration[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error("skillVersions must be an array")
  }

  const versions = value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`skillVersions[${index}] must be an object`)
    }
    const id = normalizeString(item.id, `skillVersions[${index}].id`)
    const version = item.version === undefined ? "1.0.0" : normalizeString(item.version, `skillVersions[${index}].version`)
    const minCallerVersion = item.minCallerVersion === undefined ? undefined : normalizeString(item.minCallerVersion, `skillVersions[${index}].minCallerVersion`)
    return { id, version, minCallerVersion }
  })

  return versions
}

function normalizeDependencies(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError("dependencies must be an array")
  }

  const dependencies = value.map((dependency, index) => normalizeString(dependency, `dependencies[${index}]`))
  return Array.from(new Set(dependencies))
}

function normalizeX402(value: unknown): AgentX402Manifest {
  if (!isRecord(value)) {
    throw new Error("x402 must be an object")
  }

  if (typeof value.accepts !== "boolean") {
    throw new Error("x402.accepts must be a boolean")
  }

  return {
    accepts: value.accepts,
    pricePerTask: value.pricePerTask === undefined ? undefined : normalizeString(value.pricePerTask, "x402.pricePerTask"),
  }
}

function validateDependencies(agentId: string, dependencies: string[]): void {
  for (const dependencyId of dependencies) {
    if (dependencyId === agentId) {
      throw new Error("agent cannot depend on itself")
    }
    if (!registry.agents.has(dependencyId)) {
      throw new Error(`dependency agent not found: ${dependencyId}`)
    }
  }

  const reachesAgent = (currentId: string, visited: Set<string>): boolean => {
    if (currentId === agentId) return true
    if (visited.has(currentId)) return false

    visited.add(currentId)
    const currentDependencies = currentId === agentId
      ? dependencies
      : registry.agents.get(currentId)?.dependencies ?? []

    return currentDependencies.some((dependencyId) => reachesAgent(dependencyId, visited))
  }

  if (dependencies.some((dependencyId) => reachesAgent(dependencyId, new Set()))) {
    throw new Error("agent dependencies cannot contain a cycle")
  }
}

function emitRegistryChange(action: AgentRegistryChangeAction, agent: AgentCapabilityManifest): void {
  publishSystemEvent({
    type: "agent.registry",
    action,
    agentId: agent.agentId,
    agent,
  })
}

export function getAgentRegistry(): AgentCapabilityManifest[] {
  return Array.from(registry.agents.values())
}

export function listRegisteredAgents(filters: AgentRegistryFilters = {}): AgentCapabilityManifest[] {
  return Array.from(registry.agents.values()).filter((agent) => {
    if (filters.district && agent.district !== filters.district) return false
    if (filters.status && agent.status !== filters.status) return false
    if (filters.skill && !agent.capabilities.includes(filters.skill)) return false
    if (filters.capability) {
      const needle = filters.capability.toLowerCase()
      if (!agent.capabilities.some((c) => c.toLowerCase() === needle)) return false
    }
    return true
  })
}

export function listCapabilities(): CapabilityCount[] {
  const counts = new Map<string, number>()
  for (const agent of registry.agents.values()) {
    for (const cap of agent.capabilities) {
      counts.set(cap, (counts.get(cap) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([capability, count]) => ({ capability, count }))
    .sort((a, b) => b.count - a.count || a.capability.localeCompare(b.capability))
}

export function getRegisteredAgent(agentId: string): AgentCapabilityManifest | null {
  return registry.agents.get(agentId) ?? null
}

export function getAgentDependencies(agentId: string): string[] {
  return [...(registry.agents.get(agentId)?.dependencies ?? [])]
}

export function getAgentDependents(agentId: string): string[] {
  return Array.from(registry.agents.values())
    .filter((agent) => agent.dependencies?.includes(agentId))
    .map((agent) => agent.agentId)
}

export function registerAgent(input: unknown): AgentCapabilityManifest {
  if (!isRecord(input)) {
    throw new Error("agent manifest must be an object")
  }

  const now = new Date().toISOString()
  const agentId = normalizeString(input.agentId, "agentId")
  const email = normalizeOptionalEmail(input.email)
  const dependencies = normalizeDependencies(input.dependencies)
  validateDependencies(agentId, dependencies ?? [])

  const agent: AgentCapabilityManifest = {
    agentId,
    ...(email === undefined ? {} : { email }),
    ...(input.emailOptOut === undefined ? {} : { emailOptOut: input.emailOptOut === true }),
    model: normalizeString(input.model, "model"),
    district: normalizeDistrict(input.district),
    capabilities: normalizeCapabilities(input.capabilities),
    ...(normalizeSkillVersions(input.skillVersions) === undefined ? {} : { skillVersions: normalizeSkillVersions(input.skillVersions) }),
    ...(dependencies === undefined ? {} : { dependencies }),
    x402: normalizeX402(input.x402),
    status: normalizeStatus(input.status),
    endpoint: normalizeString(input.endpoint, "endpoint"),
    registeredAt: now,
    updatedAt: now,
  }

  registry.agents.set(agent.agentId, agent)
  emitRegistryChange("registered", agent)
  return agent
}

export function updateAgentCapabilities(agentId: string, input: unknown): AgentCapabilityManifest {
  const existing = registry.agents.get(agentId)
  if (!existing) {
    throw new Error("agent not found")
  }

  if (!isRecord(input)) {
    throw new Error("capability update must be an object")
  }

  const updated: AgentCapabilityManifest = {
    ...existing,
    capabilities: normalizeCapabilities(input.capabilities),
    ...(normalizeSkillVersions(input.skillVersions) === undefined ? {} : { skillVersions: normalizeSkillVersions(input.skillVersions) }),
    updatedAt: new Date().toISOString(),
  }

  registry.agents.set(agentId, updated)
  emitRegistryChange("updated", updated)
  return updated
}

export function deregisterAgent(agentId: string): AgentCapabilityManifest | null {
  const existing = registry.agents.get(agentId)
  if (!existing) return null

  registry.agents.delete(agentId)
  emitRegistryChange("deregistered", existing)
  return existing
}

export function resetAgentRegistryForTests(): void {
  registry.agents.clear()
}
