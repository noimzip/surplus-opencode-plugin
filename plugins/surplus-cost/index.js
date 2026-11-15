import { Plugin } from "@opencode/plugin"
import { SurplusCost } from "./rpc.js"
import { settledMicro, summarize, validMicro, bestDiscountFloor, bestOffer, affordableMtok, sortByVolume } from "./core.js"

const API = "https://api.surplusintelligence.ai/v1/requests/"

export default Plugin.define({
  id: "surplus-cost",
  async setup(ctx) {
    const inflight = new Set()
    const credentials = new Map()
    let closed = false
    let marketCache
    let marketPromise

    async function marketOffers() {
      if (marketCache && Date.now() - marketCache.updated < 60000) return marketCache
      if (marketPromise) return marketPromise
      marketPromise = (async () => {
        const result = await ctx.model.list()
        const models = Array.isArray(result) ? result : result.data
        const selected = models.filter((model) => model.providerID === "surplus" && model.enabled !== false)
        const rows = await Promise.all(selected.map(async (model) => {
          try {
            const response = await fetch(`https://api.surplusintelligence.ai/api/markets/${encodeURIComponent(model.modelID || model.id)}`, { signal: AbortSignal.timeout(5000) })
            if (!response.ok) throw new Error("market unavailable")
            const market = await response.json()
            const offer = bestOffer(market)
            const volume = validMicro(market.volume_24h?.volume_usd)
            if (!offer) return { model: model.id, text: "利用可能なオファーなし", volume }
            return { model: model.id, offer, volume }
          } catch { return { model: model.id, text: "市場情報取得失敗" } }
        }))
        marketCache = { rows: sortByVolume(rows), updated: Date.now() }
        return marketCache
      })().finally(() => { marketPromise = undefined })
      return marketPromise
    }

    async function markets({ sessionID }) {
      const market = await marketOffers()
      let balance = null
      const key = credentials.get(sessionID) || process.env.SURPLUS_API_KEY
      if (key) {
        try {
          const response = await fetch("https://api.surplusintelligence.ai/v1/payments/balance", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
          if (response.ok) balance = validMicro((await response.json()).credit_balance_usdc)
        } catch { /* Unavailable balance is not zero. */ }
      }
      const price = (micro) => micro === null ? "?" : `$${(micro / 1e6).toFixed(4)}`
      const tokens = (micro) => {
        const amount = affordableMtok(balance, micro)
        return amount === null ? "?" : amount.toFixed(2)
      }
      const rows = market.rows.map((row) => row.offer ? {
        model: row.model,
        discount: row.offer.discount,
        provider: row.offer.provider,
        trusted: row.offer.trusted,
        ...(row.offer.input === null ? {} : { input: row.offer.input }),
        ...(row.offer.output === null ? {} : { output: row.offer.output }),
        ...(row.volume == null ? {} : { volume: row.volume }),
        text: `${row.offer.discount.toFixed(2)}% ${row.offer.provider}${row.offer.trusted ? " T" : " U"}\n  入 ${price(row.offer.input)} / 出 ${price(row.offer.output)}\n  目安 入 ${tokens(row.offer.input)}M / 出 ${tokens(row.offer.output)}M`,
      } : { model: row.model, text: row.text, ...(row.volume == null ? {} : { volume: row.volume }) })
      rows.sort((a, b) => (b.discount ?? -Infinity) - (a.discount ?? -Infinity) || a.model.localeCompare(b.model))
      return { rows, updated: market.updated, ...(balance === null ? {} : { balance }) }
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

    async function reconcile(record) {
      if (closed || inflight.has(record.key) || (Number.isSafeInteger(record.micro) && record.directChecked)) return
      const key = credentials.get(record.sessionID) || process.env.SURPLUS_API_KEY
      if (!key || !record.requestID) return
      inflight.add(record.key)
      try {
        const response = await fetch(API + encodeURIComponent(record.requestID), {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) return
        const row = await response.json()
        const micro = settledMicro(row)
        if (micro !== null) {
          const directMicro = validMicro(row.direct_cost_micro)
          await ctx.storage.set(record.key, { requestID: record.requestID, micro, directMicro, directChecked: true })
        }
      } catch {
        // A failed lookup is not a zero charge. Leave it pending for a later retry.
      } finally {
        inflight.delete(record.key)
      }
    }

    await ctx.session.hook("http.request", async (event) => {
      const authorization = event.request.headers.get("authorization")
      if (authorization?.startsWith("Bearer ")) credentials.set(event.sessionID, authorization.slice(7))
      try {
        const url = new URL(event.request.url)
        if (url.origin !== "https://api.surplusintelligence.ai" || !/^\/min95\/v1\/(chat\/completions|completions|responses)$/.test(url.pathname)) return
        const body = await event.request.clone().json()
        if (typeof body.model !== "string" || !body.model) return
        const market = await fetch(`https://api.surplusintelligence.ai/api/markets/${encodeURIComponent(body.model)}`, {
          signal: AbortSignal.timeout(3000),
        })
        if (!market.ok) return
        const floor = bestDiscountFloor(await market.json())
        if (floor === null) return
        url.pathname = url.pathname.replace(/^\/min95\//, `/min${floor}/`)
        event.request = new Request(url, event.request)
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

    await ctx.rpc.register(SurplusCost, {
      markets,
      session: async ({ sessionID }) => {
        const records = await scan(sessionID)
        const pending = records.find((record) => (!Number.isSafeInteger(record.micro) || !record.directChecked) && !inflight.has(record.key))
        if (pending) void reconcile({ ...pending, sessionID })
        return summarize(records)
      },
    })

    return () => { closed = true; credentials.clear() }
  },
})
