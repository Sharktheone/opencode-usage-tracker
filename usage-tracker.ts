import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { homedir, hostname } from "os"
import { join } from "path"
import { mkdirSync, existsSync } from "fs"

// ============================================================================
// Types
// ============================================================================

interface TokenUsageRecord {
  id: string
  session_id: string
  message_id: string
  model: string
  provider: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost: number | null
  created_at: string
  machine_id: string
}

interface ModelPricing {
  input: number // per million tokens
  output: number
  cacheRead: number
  cacheWrite: number
}

interface ToastConfig {
  enabled: boolean
  trigger: "messages" | "cost" | "time"
  messagesInterval: number
  costThreshold: number
  timeIntervalMinutes: number
}

interface PluginConfig {
  enabled: boolean
  dbPath: string
  machineId: string | null
  toast: ToastConfig
  pricing: Record<string, ModelPricing>
}

interface SessionStats {
  totalTokens: number
  totalCost: number
  messageCount: number
  startTime: number
  byModel: Record<string, {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number | null
  }>
}

interface AggregateStats {
  tokens: number
  cost: number
  sessions: number
  messages: number
  byModel: Record<string, { tokens: number; cost: number | null }>
}

// ============================================================================
// Default Pricing (per million tokens)
// ============================================================================

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "anthropic/claude-sonnet-4-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  "anthropic/claude-opus-4-5": { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },

  // OpenAI GPT-5 family
  "openai/gpt-5": { input: 1.25, output: 10.00, cacheRead: 0.125, cacheWrite: 0.0 },
  "openai/gpt-5.1": { input: 1.25, output: 10.00, cacheRead: 0.125, cacheWrite: 0.0 },
  "openai/gpt-5.2": { input: 1.75, output: 14.00, cacheRead: 0.175, cacheWrite: 0.0 },
  "openai/gpt-5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.0 },
}

// ============================================================================
// Database Layer
// ============================================================================

class UsageDatabase {
  private db: Database
  
  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"))
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    
    this.db = new Database(dbPath, { create: true })
    this.migrate()
  }
  
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL,
        created_at TEXT NOT NULL,
        machine_id TEXT NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_created_at ON token_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_session_id ON token_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_model ON token_usage(model);
      CREATE INDEX IF NOT EXISTS idx_machine_id ON token_usage(machine_id);
    `)
  }
  
  insert(record: TokenUsageRecord): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO token_usage 
        (id, session_id, message_id, model, provider, input_tokens, output_tokens, 
         cache_read_tokens, cache_write_tokens, cost, created_at, machine_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(
        record.id,
        record.session_id,
        record.message_id,
        record.model,
        record.provider,
        record.input_tokens,
        record.output_tokens,
        record.cache_read_tokens,
        record.cache_write_tokens,
        record.cost,
        record.created_at,
        record.machine_id
      )
      return true
    } catch (e) {
      return false
    }
  }
  
  hasMessage(messageId: string): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM token_usage WHERE message_id = ?")
    return stmt.get(messageId) !== null
  }
  
  getSessionStats(sessionId: string): TokenUsageRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM token_usage WHERE session_id = ? ORDER BY created_at ASC
    `)
    return stmt.all(sessionId) as TokenUsageRecord[]
  }
  
  getAggregateStats(
    machineId: string,
    startDate: string,
    endDate: string,
    modelFilter?: string
  ): { records: TokenUsageRecord[], sessionCount: number } {
    let query = `
      SELECT * FROM token_usage 
      WHERE machine_id = ? 
        AND created_at >= ? 
        AND created_at < ?
    `
    const params: (string | number)[] = [machineId, startDate, endDate]
    
    if (modelFilter) {
      query += ` AND model LIKE ?`
      params.push(`%${modelFilter}%`)
    }
    
    query += ` ORDER BY created_at ASC`
    
    const stmt = this.db.prepare(query)
    const records = stmt.all(...params) as TokenUsageRecord[]
    
    // Count unique sessions
    const sessionIds = new Set(records.map(r => r.session_id))
    
    return { records, sessionCount: sessionIds.size }
  }
  
  close() {
    this.db.close()
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function generateId(): string {
  return crypto.randomUUID()
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return join(homedir(), p.slice(1))
  }
  return p
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

function formatCost(cost: number | null): string {
  if (cost === null) return "-"
  return `$${cost.toFixed(4)}`
}

function formatDuration(startTime: number): string {
  const minutes = Math.floor((Date.now() - startTime) / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function getStartOfDay(date: Date = new Date()): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString()
}

function getStartOfWeek(date: Date = new Date()): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Monday start
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function getStartOfMonth(date: Date = new Date()): string {
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString()
}

function getStartOfYear(date: Date = new Date()): string {
  return new Date(date.getFullYear(), 0, 1).toISOString()
}

function calculateAggregates(records: TokenUsageRecord[]): Omit<AggregateStats, 'sessions'> {
  const byModel: Record<string, { tokens: number; cost: number | null }> = {}
  let totalTokens = 0
  let totalCost = 0
  let hasAnyCost = false
  
  for (const r of records) {
    const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens
    totalTokens += tokens
    
    if (r.cost !== null) {
      totalCost += r.cost
      hasAnyCost = true
    }
    
    if (!byModel[r.model]) {
      byModel[r.model] = { tokens: 0, cost: null }
    }
    byModel[r.model].tokens += tokens
    if (r.cost !== null) {
      byModel[r.model].cost = (byModel[r.model].cost ?? 0) + r.cost
    }
  }
  
  return {
    tokens: totalTokens,
    cost: hasAnyCost ? totalCost : 0,
    messages: records.length,
    byModel
  }
}

// ============================================================================
// Config Helpers
// ============================================================================

function getConfig(rawConfig: unknown): PluginConfig {
  const c = (rawConfig as Record<string, unknown>)?.["usage-tracker"] as Partial<PluginConfig> | undefined
  
  return {
    enabled: c?.enabled ?? true,
    dbPath: expandPath(c?.dbPath ?? "~/.config/opencode/token-usage.db"),
    machineId: c?.machineId ?? hostname(),
    toast: {
      enabled: c?.toast?.enabled ?? false,
      trigger: c?.toast?.trigger ?? "messages",
      messagesInterval: c?.toast?.messagesInterval ?? 5,
      costThreshold: c?.toast?.costThreshold ?? 0.10,
      timeIntervalMinutes: c?.toast?.timeIntervalMinutes ?? 10,
    },
    pricing: { ...DEFAULT_PRICING, ...c?.pricing }
  }
}

function getPricing(model: string, config: PluginConfig): ModelPricing | null {
  // Try exact match first
  if (config.pricing[model]) return config.pricing[model]
  
  // Try without provider prefix
  const modelName = model.split("/").pop()
  for (const [key, pricing] of Object.entries(config.pricing)) {
    if (key.endsWith(`/${modelName}`) || key === modelName) {
      return pricing
    }
  }
  
  return null
}

function calculateCost(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  pricing: ModelPricing | null,
  opencodeCost?: number
): number | null {
  // Custom pricing takes precedence
  if (pricing) {
    return (
      (tokens.input * pricing.input / 1_000_000) +
      (tokens.output * pricing.output / 1_000_000) +
      (tokens.cacheRead * pricing.cacheRead / 1_000_000) +
      (tokens.cacheWrite * pricing.cacheWrite / 1_000_000)
    )
  }
  
  // Fall back to OpenCode's cost if available
  if (opencodeCost !== undefined && opencodeCost > 0) {
    return opencodeCost
  }
  
  return null
}

// ============================================================================
// Formatting Functions
// ============================================================================

function formatUsageCompact(stats: SessionStats): string {
  const lines: string[] = []
  const totalTokens = formatTokens(stats.totalTokens)
  const cost = stats.totalCost > 0 ? formatCost(stats.totalCost) : "-"
  const duration = formatDuration(stats.startTime)
  
  lines.push(`Session: ${totalTokens} tokens | ${cost} | ${stats.messageCount} msgs | ${duration}`)
  
  for (const [model, data] of Object.entries(stats.byModel)) {
    const modelName = model.split("/").pop() ?? model
    const tokens = formatTokens(data.input + data.output + data.cacheRead + data.cacheWrite)
    const modelCost = data.cost !== null ? formatCost(data.cost) : "-"
    lines.push(`  ${modelName}: ${tokens} tk / ${modelCost}`)
  }
  
  return lines.join("\n")
}

function formatUsageFull(stats: SessionStats): string {
  const lines: string[] = []
  
  lines.push("Session Usage")
  lines.push("━".repeat(50))
  
  for (const [model, data] of Object.entries(stats.byModel)) {
    const modelName = model.split("/").pop() ?? model
    const total = data.input + data.output + data.cacheRead + data.cacheWrite
    lines.push(`${modelName}`)
    lines.push(`  Input:       ${data.input.toLocaleString().padStart(10)} tk    ${data.cost !== null ? formatCost((data.input / total) * data.cost) : "-"}`)
    lines.push(`  Output:      ${data.output.toLocaleString().padStart(10)} tk    ${data.cost !== null ? formatCost((data.output / total) * data.cost) : "-"}`)
    lines.push(`  Cache Read:  ${data.cacheRead.toLocaleString().padStart(10)} tk    ${data.cost !== null ? formatCost((data.cacheRead / total) * data.cost) : "-"}`)
    lines.push(`  Cache Write: ${data.cacheWrite.toLocaleString().padStart(10)} tk    ${data.cost !== null ? formatCost((data.cacheWrite / total) * data.cost) : "-"}`)
    lines.push(`  ${"─".repeat(40)}`)
    lines.push(`  Subtotal:    ${total.toLocaleString().padStart(10)} tk    ${formatCost(data.cost)}`)
    lines.push("")
  }
  
  lines.push("━".repeat(50))
  lines.push(`Total: ${formatTokens(stats.totalTokens)} tokens | ${formatCost(stats.totalCost)} | ${stats.messageCount} msgs`)
  
  return lines.join("\n")
}

function formatGlobalCompact(
  today: AggregateStats,
  week: AggregateStats,
  month: AggregateStats,
  year?: AggregateStats,
  allTime?: AggregateStats
): string {
  const lines: string[] = []
  
  lines.push(`Today:  ${formatTokens(today.tokens)} tk | ${formatCost(today.cost)} | ${today.sessions} sess`)
  lines.push(`Week:   ${formatTokens(week.tokens)} tk | ${formatCost(week.cost)} | ${week.sessions} sess`)
  lines.push(`Month:  ${formatTokens(month.tokens)} tk | ${formatCost(month.cost)} | ${month.sessions} sess`)
  
  if (year) {
    lines.push(`Year:   ${formatTokens(year.tokens)} tk | ${formatCost(year.cost)} | ${year.sessions} sess`)
  }
  
  if (allTime) {
    lines.push(`All:    ${formatTokens(allTime.tokens)} tk | ${formatCost(allTime.cost)} | ${allTime.sessions} sess`)
  }
  
  return lines.join("\n")
}

function formatGlobalFull(
  today: AggregateStats,
  week: AggregateStats,
  month: AggregateStats,
  year?: AggregateStats,
  allTime?: AggregateStats
): string {
  const lines: string[] = []
  
  const formatPeriod = (name: string, stats: AggregateStats) => {
    lines.push(`${name}`)
    lines.push("─".repeat(50))
    
    for (const [model, data] of Object.entries(stats.byModel)) {
      const modelName = model.split("/").pop() ?? model
      lines.push(`  ${modelName.padEnd(30)} ${formatTokens(data.tokens).padStart(10)} tk  ${formatCost(data.cost).padStart(8)}`)
    }
    
    lines.push(`  ${"─".repeat(48)}`)
    lines.push(`  ${"Total".padEnd(30)} ${formatTokens(stats.tokens).padStart(10)} tk  ${formatCost(stats.cost).padStart(8)}`)
    lines.push(`  Sessions: ${stats.sessions} | Messages: ${stats.messages}`)
    lines.push("")
  }
  
  lines.push("Global Token Usage")
  lines.push("━".repeat(50))
  lines.push("")
  
  formatPeriod("Today", today)
  formatPeriod("This Week", week)
  formatPeriod("This Month", month)
  
  if (year) formatPeriod("This Year", year)
  if (allTime) formatPeriod("All Time", allTime)
  
  return lines.join("\n")
}

function buildSessionStats(records: TokenUsageRecord[]): SessionStats {
  const stats: SessionStats = {
    totalTokens: 0,
    totalCost: 0,
    messageCount: records.length,
    startTime: records.length > 0 ? new Date(records[0].created_at).getTime() : Date.now(),
    byModel: {}
  }
  
  for (const r of records) {
    const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens
    stats.totalTokens += tokens
    if (r.cost !== null) stats.totalCost += r.cost
    
    if (!stats.byModel[r.model]) {
      stats.byModel[r.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }
    }
    stats.byModel[r.model].input += r.input_tokens
    stats.byModel[r.model].output += r.output_tokens
    stats.byModel[r.model].cacheRead += r.cache_read_tokens
    stats.byModel[r.model].cacheWrite += r.cache_write_tokens
    if (r.cost !== null) {
      stats.byModel[r.model].cost = (stats.byModel[r.model].cost ?? 0) + r.cost
    }
  }
  
  return stats
}

// ============================================================================
// Plugin Export
// ============================================================================

export const UsageTrackerPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  
  // Load config
  const configResult = await client.config.get()
  const config = getConfig(configResult.data)
  
  if (!config.enabled) {
    return {}
  }
  
  // Initialize database
  let db: UsageDatabase
  try {
    db = new UsageDatabase(config.dbPath)
  } catch (e) {
    await client.tui.showToast({
      body: { message: `Usage tracker: Failed to open database: ${e}`, variant: "error" }
    })
    return {}
  }
  
  // Session state (in-memory cache)
  const sessionStats: Map<string, SessionStats> = new Map()
  const processedMessages = new Set<string>()
  
  // Toast tracking
  let lastToastTime = Date.now()
  let messagesSinceToast = 0
  let costSinceToast = 0
  
  const getOrCreateSessionStats = (sessionId: string): SessionStats => {
    if (!sessionStats.has(sessionId)) {
      sessionStats.set(sessionId, {
        totalTokens: 0,
        totalCost: 0,
        messageCount: 0,
        startTime: Date.now(),
        byModel: {}
      })
    }
    return sessionStats.get(sessionId)!
  }
  
  const shouldShowToast = (): boolean => {
    if (!config.toast.enabled) return false
    
    switch (config.toast.trigger) {
      case "messages":
        return messagesSinceToast >= config.toast.messagesInterval
      case "cost":
        return costSinceToast >= config.toast.costThreshold
      case "time":
        return (Date.now() - lastToastTime) >= config.toast.timeIntervalMinutes * 60 * 1000
      default:
        return false
    }
  }
  
  const resetToastTracking = () => {
    lastToastTime = Date.now()
    messagesSinceToast = 0
    costSinceToast = 0
  }
  
  // Helper to get current session ID
  const getCurrentSessionId = async (): Promise<string | null> => {
    try {
      const sessionsResult = await client.session.list()
      const sessions = sessionsResult.data ?? []
      if (sessions.length === 0) return null
      return sessions[0].id
    } catch {
      return null
    }
  }

  return {
    event: async ({ event }) => {
      // Track token usage from completed assistant messages
      if (event.type === "message.updated") {
        const message = event.properties.info
        
        // Only process completed assistant messages with tokens
        if (
          message.role !== "assistant" ||
          !message.time.completed ||
          !message.tokens ||
          processedMessages.has(message.id)
        ) {
          return
        }
        
        // Check if already in DB (handles restarts)
        if (db.hasMessage(message.id)) {
          processedMessages.add(message.id)
          return
        }
        
        const tokens = {
          input: message.tokens.input ?? 0,
          output: message.tokens.output ?? 0,
          cacheRead: message.tokens.cache?.read ?? 0,
          cacheWrite: message.tokens.cache?.write ?? 0
        }
        
        // Extract model info - try multiple paths to find model
        let model = "unknown"
        const msg = message as Record<string, unknown>
        if (typeof msg.model === "string") {
          model = msg.model
        } else if (msg.model && typeof (msg.model as Record<string, unknown>).modelID === "string") {
          const providerID = (msg.model as Record<string, unknown>).providerID ?? ""
          const modelID = (msg.model as Record<string, unknown>).modelID ?? ""
          model = providerID ? `${providerID}/${modelID}` : modelID as string
        }
        
        const provider = model.split("/")[0] ?? "unknown"
        
        // Calculate cost
        const pricing = getPricing(model, config)
        const cost = calculateCost(tokens, pricing, message.cost)
        
        // Create record
        const record: TokenUsageRecord = {
          id: generateId(),
          session_id: message.sessionID,
          message_id: message.id,
          model,
          provider,
          input_tokens: tokens.input,
          output_tokens: tokens.output,
          cache_read_tokens: tokens.cacheRead,
          cache_write_tokens: tokens.cacheWrite,
          cost,
          created_at: new Date().toISOString(),
          machine_id: config.machineId ?? hostname()
        }
        
        // Insert into DB
        const success = db.insert(record)
        if (!success) {
          await client.tui.showToast({
            body: { message: "Usage tracker: Failed to save token usage", variant: "error" }
          })
          return
        }
        
        processedMessages.add(message.id)
        
        // Update session stats
        const stats = getOrCreateSessionStats(message.sessionID)
        const totalMsgTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
        stats.totalTokens += totalMsgTokens
        if (cost !== null) stats.totalCost += cost
        stats.messageCount++
        
        if (!stats.byModel[model]) {
          stats.byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }
        }
        stats.byModel[model].input += tokens.input
        stats.byModel[model].output += tokens.output
        stats.byModel[model].cacheRead += tokens.cacheRead
        stats.byModel[model].cacheWrite += tokens.cacheWrite
        if (cost !== null) {
          stats.byModel[model].cost = (stats.byModel[model].cost ?? 0) + cost
        }
        
        // Toast tracking
        messagesSinceToast++
        if (cost !== null) costSinceToast += cost
        
        // Show toast if triggered
        if (shouldShowToast()) {
          const toastMsg = `+${formatTokens(totalMsgTokens)} tk | ${cost !== null ? formatCost(cost) : "-"} | Total: ${formatCost(stats.totalCost)}`
          await client.tui.showToast({
            body: { message: toastMsg, variant: "info" }
          })
          resetToastTracking()
        }
      }
    },
    
    tool: {
      usage: tool({
        description: "Show token usage statistics for the current session. Use --full for detailed breakdown by token type.",
        args: {
          full: tool.schema.boolean().optional().describe("Show detailed breakdown with input/output/cache tokens per model")
        },
        async execute(args) {
          const sessionId = await getCurrentSessionId()
          if (!sessionId) {
            return "No active session"
          }
          
          // Get stats from memory or load from DB
          let stats = sessionStats.get(sessionId)
          
          if (!stats || stats.messageCount === 0) {
            // Load from DB
            const records = db.getSessionStats(sessionId)
            if (records.length === 0) {
              return "No usage data for this session yet"
            }
            stats = buildSessionStats(records)
          }
          
          return args.full ? formatUsageFull(stats) : formatUsageCompact(stats)
        }
      }),
      
      globalusage: tool({
        description: "Show global token usage statistics across all sessions. Shows today, this week, and this month by default.",
        args: {
          full: tool.schema.boolean().optional().describe("Show detailed breakdown by model for each time period"),
          year: tool.schema.boolean().optional().describe("Include yearly statistics"),
          all: tool.schema.boolean().optional().describe("Include all-time statistics"),
          model: tool.schema.string().optional().describe("Filter by model name (partial match)")
        },
        async execute(args) {
          const machineId = config.machineId ?? hostname()
          const now = new Date()
          const farFuture = "2100-01-01T00:00:00.000Z"
          
          // Get aggregates for each period
          const todayData = db.getAggregateStats(machineId, getStartOfDay(now), farFuture, args.model)
          const weekData = db.getAggregateStats(machineId, getStartOfWeek(now), farFuture, args.model)
          const monthData = db.getAggregateStats(machineId, getStartOfMonth(now), farFuture, args.model)
          
          const todayAgg = calculateAggregates(todayData.records)
          const weekAgg = calculateAggregates(weekData.records)
          const monthAgg = calculateAggregates(monthData.records)
          
          const today: AggregateStats = { ...todayAgg, sessions: todayData.sessionCount }
          const week: AggregateStats = { ...weekAgg, sessions: weekData.sessionCount }
          const month: AggregateStats = { ...monthAgg, sessions: monthData.sessionCount }
          
          let year: AggregateStats | undefined
          let allTime: AggregateStats | undefined
          
          if (args.year || args.all) {
            const yearData = db.getAggregateStats(machineId, getStartOfYear(now), farFuture, args.model)
            const yearAgg = calculateAggregates(yearData.records)
            year = { ...yearAgg, sessions: yearData.sessionCount }
          }
          
          if (args.all) {
            const allData = db.getAggregateStats(machineId, "1970-01-01T00:00:00.000Z", farFuture, args.model)
            const allAgg = calculateAggregates(allData.records)
            allTime = { ...allAgg, sessions: allData.sessionCount }
          }
          
          return args.full 
            ? formatGlobalFull(today, week, month, year, allTime)
            : formatGlobalCompact(today, week, month, year, allTime)
        }
      })
    }
  }
}

export default UsageTrackerPlugin
