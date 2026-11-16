import { Plugin } from "@opencode/plugin"
import { SurplusCost } from "./rpc.js"
import { settledMicro, summarize, validMicro, bestDiscountFloor, bestOffer, formatUsdMicro, formatMtok } from "./core.js"

const API = "https://api.surplusintelligence.ai/v1/requests/"
const ORIGIN = "https://api.surplusintelligence.ai"
const FLOOR_CACHE_TTL_MS = 20000
const MARKET_CACHE_TTL_MS = 60000
const RECONCILE_CONCURRENCY = 4
const RETRY_BASE_MS = 5000
const RETRY_MAX_MS = 300000
const DIRECT_RECHECK_COOLDOWN_MS = 15000
const MAX_DIRECT_ATTEMPTS = 5
const FINAL_SETTLEMENT_STATUSES = new Set(["settled", "confirmed", "completed", "paid"])

/** Create the Surplus Intelligence server plugin definition with injectable runtime dependencies. */
export function createSurplusCostPlugin(deps = {}) {
  const {
    fetch: fetchFn = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    env = process.env,
    contract = SurplusCost,
  } = deps

  return {
    id: "surplus-cost",
    async setup(ctx) {
      const inflight = new Set()
      const credentials = new Map()
      const retryState = new Map()
      const floorCache = new Map()
      const floorInflight = new Map()
      let latestCredential
      let closed = false
      let marketCache
      let marketPromise

      function resolveKey(sessionID) {
        return credentials.get(sessionID) || env?.SURPLUS_API_KEY || latestCredential
      }

      async function marketOffers(refresh = false) {
        if (!refresh && marketCache && now() - marketCache.updated < MARKET_CACHE_TTL_MS) return marketCache
        if (!refresh && marketPromise) return marketPromise
        const promise = (async () => {
          const result = await ctx.model.list()
          const models = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []
          const selected = models.filter((model) => model?.providerID === "surplus" && model.enabled !== false)
          let okCount = 0
          const rows = await Promise.all(selected.map(async (model) => {
            try {
              const response = await fetchFn(`${ORIGIN}/api/markets/${encodeURIComponent(model.modelID || model.id)}`, { signal: AbortSignal.timeout(5000) })
              if (!response.ok) throw new Error("market unavailable")
              const market = await response.json()
              okCount++
              const offer = bestOffer(market)
              const volume = validMicro(market.volume_24h?.volume_usd)
              if (!offer) return { model: model.id, text: "No available offers", volume }
              return { model: model.id, offer, volume }
            } catch { return { model: model.id, text: "Market data unavailable" } }
          }))
          const snapshot = { rows, updated: now() }
          if (selected.length === 0 || okCount > 0) marketCache = snapshot
          return snapshot
        })()
        marketPromise = promise
        try {
          return await promise
        } finally {
          if (marketPromise === promise) marketPromise = undefined
        }
      }

      async function markets({ sessionID, refresh } = {}) {
        const market = await marketOffers(refresh === true)
        let balance = null
        const key = resolveKey(sessionID)
        if (key) {
          try {
            const response = await fetchFn(`${ORIGIN}/v1/payments/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
            if (response.ok) balance = validMicro((await response.json()).credit_balance_usdc)
          } catch { /* Unavailable balance is not zero. */ }
        }
        const rows = market.rows.map((row) => row.offer ? {
          model: row.model,
          discount: row.offer.discount,
          provider: row.offer.provider,
          trusted: row.offer.trusted,
          ...(row.offer.input === null ? {} : { input: row.offer.input }),
          ...(row.offer.output === null ? {} : { output: row.offer.output }),
          ...(row.volume == null ? {} : { volume: row.volume }),
          text: `${row.offer.discount.toFixed(2)}% ${row.offer.provider}${row.offer.trusted ? " T" : " U"}\n  In ${formatUsdMicro(row.offer.input)} / Out ${formatUsdMicro(row.offer.output)}\n  Est. In ${formatMtok(balance, row.offer.input)}M / Out ${formatMtok(balance, row.offer.output)}M`,
        } : { model: row.model, text: row.text, ...(row.volume == null ? {} : { volume: row.volume }) })
        rows.sort((a, b) => (b.discount ?? -Infinity) - (a.discount ?? -Infinity) || a.model.localeCompare(b.model))
        return { rows, updated: market.updated, ...(balance === null ? {} : { balance }) }
      }

      async function getModelFloor(model) {
        const cached = floorCache.get(model)
        if (cached && now() - cached.updated < FLOOR_CACHE_TTL_MS) return cached.floor
        const existing = floorInflight.get(model)
        if (existing) return existing
        const promise = (async () => {
          try {
            const market = await fetchFn(`${ORIGIN}/api/markets/${encodeURIComponent(model)}`, {
              signal: AbortSignal.timeout(3000),
            })
            if (!market.ok) return null
            const floor = bestDiscountFloor(await market.json())
            floorCache.set(model, { floor, updated: now() })
            return floor
          } catch {
            return null
          } finally {
            if (floorInflight.get(model) === promise) floorInflight.delete(model)
          }
        })()
        floorInflight.set(model, promise)
        return promise
      }

      async function scan(sessionID) {
        const prefix = `requests/${encodeURIComponent(sessionID)}/`
        const records = []
        let after
        do {
          const page = await ctx.storage.scan({ prefix, after, limit: 100 })
          records.push(...page.entries.map((entry) => ({ key: entry.key, ...entry.value })))
          after = page.next
        } while (after)
        return records
      }

      function recordFailure(key) {
        const prev = retryState.get(key)
        const attempts = (prev?.attempts ?? 0) + 1
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (attempts - 1)))
        retryState.set(key, { attempts, nextAttempt: now() + delay })
      }

      function needsReconcile(record, currentTime = now()) {
        if (inflight.has(record.key)) return false
        if (Number.isSafeInteger(record.micro) && record.directChecked) return false
        const retry = retryState.get(record.key)
        return !retry || retry.nextAttempt <= currentTime
      }

      async function reconcile(record) {
        if (closed || !needsReconcile(record)) return
        const key = resolveKey(record.sessionID)
        if (!key || !record.requestID) return
        inflight.add(record.key)
        try {
          const response = await fetchFn(API + encodeURIComponent(record.requestID), {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(10000),
          })
          if (!response.ok) {
            recordFailure(record.key)
            return
          }
          const row = await response.json()
          const micro = settledMicro(row)
          if (micro === null) {
            retryState.delete(record.key)
            return
          }
          const directMicro = validMicro(row.direct_cost_micro)
          const finalized = FINAL_SETTLEMENT_STATUSES.has(row.settlement_status)
          const directAttempts = (record.directAttempts ?? 0) + 1
          const directChecked = directMicro !== null || finalized || directAttempts >= MAX_DIRECT_ATTEMPTS
          if (closed) return
          await ctx.storage.set(record.key, {
            requestID: record.requestID,
            micro,
            directMicro,
            directChecked,
            directAttempts,
          })
          if (directChecked) {
            retryState.delete(record.key)
          } else {
            retryState.set(record.key, { attempts: 0, nextAttempt: now() + DIRECT_RECHECK_COOLDOWN_MS })
          }
        } catch {
          // A failed lookup is not a zero charge. Leave it pending for a later retry.
          recordFailure(record.key)
        } finally {
          inflight.delete(record.key)
        }
      }

      function reconcileBatch(records, sessionID) {
        if (closed || records.length === 0) return
        const available = RECONCILE_CONCURRENCY - inflight.size
        if (available <= 0) return
        const queue = [...records]
        const workers = Array.from({ length: Math.min(available, queue.length) }, async () => {
          while (!closed && queue.length > 0) {
            const next = queue.shift()
            if (next) await reconcile({ ...next, sessionID })
          }
        })
        void Promise.all(workers)
      }

      await ctx.session.hook("http.request", async (event) => {
        try {
          const url = new URL(event.request.url)
          if (url.origin !== ORIGIN) return
          const authorization = event.request.headers.get("authorization")
          const match = authorization?.match(/^bearer\s+(.+)$/i)
          if (match) {
            const token = match[1].trim()
            if (token) {
              credentials.set(event.sessionID, token)
              latestCredential = token
            }
          }
          if (!/^\/min95\/v1\/(chat\/completions|completions|responses)$/.test(url.pathname)) return
          const req = event.request
          if (req.bodyUsed) return
          const body = await req.clone().json()
          if (typeof body?.model !== "string" || !body.model) return
          const floor = await getModelFloor(body.model)
          if (floor === null || floor <= 95) return
          url.pathname = url.pathname.replace(/^\/min95\//, `/min${floor}/`)
          event.request = new Request(url, {
            method: req.method,
            headers: req.headers,
            body: req.body ? req.clone().body : null,
            ...(req.body ? { duplex: "half" } : {}),
            signal: req.signal,
          })
        } catch {
          // Fail closed to the existing min95 if market lookup or parsing fails.
        }
      }, { providerID: "surplus" })

      await ctx.session.hook("http.response", async (event) => {
        const response = event.response
        const requestID = response.headers.get("x-request-id")
        if (!requestID || !response.ok) return
        const key = `requests/${encodeURIComponent(event.sessionID)}/${encodeURIComponent(requestID)}`
        try {
          const previous = await ctx.storage.get(key)
          if (previous) return
          const record = { requestID }
          await ctx.storage.set(key, record)
          // The streamed response can settle later. The UI refresh retries pending records.
          void reconcile({ key, sessionID: event.sessionID, ...record })
        } catch {
          // Accounting must not break the inference stream.
        }
      }, { providerID: "surplus" })

      await ctx.rpc.register(contract, {
        markets,
        session: async ({ sessionID }) => {
          if (!sessionID) return summarize([])
          const records = await scan(sessionID)
          const currentTime = now()
          const due = records.filter((record) => needsReconcile(record, currentTime))
          reconcileBatch(due, sessionID)
          return summarize(records)
        },
      })

      return () => {
        closed = true
        credentials.clear()
        latestCredential = undefined
        retryState.clear()
        floorCache.clear()
        floorInflight.clear()
      }
    },
  }
}

export default Plugin.define(createSurplusCostPlugin())
