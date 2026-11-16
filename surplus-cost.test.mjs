import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode/plugin") {
      return { shortCircuit: true, url: "virtual:opencode-plugin" }
    }
    if (specifier === "@opencode/plugin/rpc") {
      return { shortCircuit: true, url: "virtual:opencode-plugin-rpc" }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === "virtual:opencode-plugin") {
      return {
        shortCircuit: true,
        format: "module",
        source: "export const Plugin = { define: (def) => def }\n",
      }
    }
    if (url === "virtual:opencode-plugin-rpc") {
      return {
        shortCircuit: true,
        format: "module",
        source: "export const Rpc = { define: (def) => def }\n",
      }
    }
    return nextLoad(url, context)
  },
})

const { default: defaultPlugin, createSurplusCostPlugin } = await import("./plugins/surplus-cost/index.js")
const { SurplusCost } = await import("./plugins/surplus-cost/rpc.js")
const {
  validMicro,
  affordableMtok,
  formatUsdMicro,
  formatMtok,
  sortByVolume,
  bestDiscountFloor,
  bestOffer,
  settledMicro,
  summarize,
} = await import("./plugins/surplus-cost/core.js")
const { defaults, sorts, fields, sortRows, rowText } = await import("./plugins/surplus-cost/display.js")

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

async function flushAsync() {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function setupPlugin({
  fetch = async () => {
    throw new Error("unexpected fetch")
  },
  now = () => 1_000_000,
  env = {},
  models = () => ({ data: [{ id: "test", providerID: "surplus", enabled: true }] }),
} = {}) {
  const store = new Map()
  const hooks = new Map()
  let registered
  const ctx = {
    model: { list: async () => (typeof models === "function" ? models() : models) },
    session: {
      hook: async (name, fn, opts) => {
        hooks.set(name, { fn, opts })
      },
    },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => {
        store.set(k, v)
      },
      scan: async ({ prefix, after, limit = 100 }) => {
        const matching = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
        const start = after ? matching.findIndex(([k]) => k === after) + 1 : 0
        const slice = matching.slice(start, start + limit)
        const next = start + limit < matching.length ? slice[slice.length - 1]?.[0] : undefined
        return { entries: slice.map(([key, value]) => ({ key, value })), next }
      },
    },
    rpc: {
      register: async (contract, methods) => {
        registered = { contract, ...methods }
      },
    },
  }
  const plugin = createSurplusCostPlugin({ fetch, now, env })
  const cleanup = await plugin.setup(ctx)
  return {
    store,
    hooks: {
      request: hooks.get("http.request")?.fn,
      response: hooks.get("http.response")?.fn,
      requestOpts: hooks.get("http.request")?.opts,
      responseOpts: hooks.get("http.response")?.opts,
    },
    rpc: registered,
    cleanup,
    ctx,
  }
}

describe("core.js", () => {
  it("validates non-negative integer microdollars", () => {
    assert.equal(validMicro(0), 0)
    assert.equal(validMicro("12345"), 12345)
    assert.equal(validMicro(-1), null)
    assert.equal(validMicro("1.5"), null)
    assert.equal(validMicro(" 10 "), null)
    assert.equal(validMicro(NaN), null)
    assert.equal(validMicro(Number.MAX_SAFE_INTEGER + 1), null)
  })

  it("formats USD microdollars and affordable Mtok", () => {
    assert.equal(formatUsdMicro(0), "$0.0000")
    assert.equal(formatUsdMicro(18500), "$0.0185")
    assert.equal(formatUsdMicro("1000000"), "$1.0000")
    assert.equal(formatUsdMicro(null), "?")
    assert.equal(formatUsdMicro(-5), "?")

    assert.equal(affordableMtok("1000000", 500000), 2)
    assert.equal(affordableMtok(0, 500000), 0)
    assert.equal(affordableMtok(null, 500000), null)
    assert.equal(affordableMtok(100, 0), null)

    assert.equal(formatMtok(1850000, 18500), "100.00")
    assert.equal(formatMtok(0, 18500), "0.00")
    assert.equal(formatMtok(undefined, 18500), "?")
    assert.equal(formatMtok(1850000, 0), "?")
  })

  it("computes bestDiscountFloor within 0..100", () => {
    assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: 98.15 } }), 98)
    assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: 0 } }), 0)
    assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: 100 } }), 100)
    assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: -0.1 } }), null)
    assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: 101 } }), null)
    assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: null } }), null)
  })

  it("enforces 0..100 discount bounds and filtering in bestOffer", () => {
    assert.equal(bestOffer({ offers: [] }), null)
    assert.equal(bestOffer(null), null)
    assert.deepEqual(
      bestOffer({
        offers: [
          { available: true, healthy: true, discount_pct: 100.1, provider: "bad-high" },
          { available: true, healthy: true, discount_pct: -1, provider: "bad-low" },
          { available: true, healthy: true, discount_pct: Number.NaN, provider: "bad-nan" },
          { available: false, healthy: true, discount_pct: 99, provider: "unavail" },
          { available: true, healthy: false, discount_pct: 99, provider: "unhealthy" },
          {
            available: true,
            healthy: true,
            discount_pct: 98,
            rank: 2,
            effective_input_per_1m: 123,
            effective_output_per_1m: 456,
            provider: "ranked-2",
            trusted: true,
            cap_remaining: 100,
          },
          {
            available: true,
            healthy: true,
            discount_pct: 98,
            rank: 1,
            effective_input_per_1m: 100,
            effective_output_per_1m: 400,
            provider: 42,
            trusted: false,
          },
        ],
      }),
      { discount: 98, input: 100, output: 400, provider: "?", trusted: false },
    )
    assert.deepEqual(
      bestOffer({
        offers: [
          { available: true, healthy: true, discount_pct: 0, provider: "zero", trusted: true },
        ],
      }),
      { discount: 0, input: null, output: null, provider: "zero", trusted: true },
    )
    assert.deepEqual(
      bestOffer({
        offers: [
          { available: true, healthy: true, discount_pct: 100, provider: "hundred", trusted: false },
        ],
      }),
      { discount: 100, input: null, output: null, provider: "hundred", trusted: false },
    )
  })

  it("extracts settledMicro and summarizes records", () => {
    for (const status of ["accrued", "settled", "confirmed", "completed", "paid"]) {
      assert.equal(settledMicro({ settlement_status: status, buyer_cost_micro: 1234 }), 1234)
    }
    assert.equal(settledMicro({ settlement_status: "settled", buyer_cost_micro: "0" }), 0)
    assert.equal(settledMicro({ settlement_status: "pending", buyer_cost_micro: 1234 }), null)
    assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: null }), null)
    assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: -1 }), null)
    assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: "1.5" }), null)

    assert.deepEqual(
      summarize([{ micro: 100, directMicro: 200 }, { micro: 0, directMicro: 0 }, {}]),
      { micro: 100, settled: 2, pending: 1, directMicro: 200, comparedMicro: 100, compared: 1 },
    )
  })

  it("sorts by volume safely", () => {
    assert.deepEqual(
      sortByVolume([{ model: "missing" }, { model: "low", volume: 0 }, { model: "high", volume: "123" }, { model: "mid", volume: 5 }]).map((x) => x.model),
      ["high", "mid", "low", "missing"],
    )
  })
})

describe("display.js", () => {
  const sampleRows = [
    { model: "b", discount: 92, input: 10, output: 50, volume: 3 },
    { model: "a", discount: 99, input: 20, output: 5, volume: 9 },
    { model: "z", text: "Unknown" },
  ]

  it("sorts rows across all sort modes", () => {
    for (const [sort, expected] of Object.entries({
      discount: ["a", "b", "z"],
      input: ["b", "a", "z"],
      output: ["a", "b", "z"],
      model: ["a", "b", "z"],
      volume: ["a", "b", "z"],
      unknown: ["a", "b", "z"],
    })) {
      assert.deepEqual(sortRows(sampleRows, sort).map((row) => row.model), expected)
    }
  })

  it("handles rowText edge cases (discount 0, balance 0/undefined, missing provider, toggles)", () => {
    assert.match(rowText({ ...sampleRows[0], provider: "Test", trusted: true }, defaults, 100), /92\.00% Test T/)
    assert.doesNotMatch(
      rowText({ ...sampleRows[0], provider: "Test", trusted: true }, { ...defaults, provider: false, prices: false }, 100),
      /Test|In \$/,
    )

    const zeroDiscount = rowText({ model: "m", discount: 0, provider: "ZeroCo", trusted: false, input: 1000, output: 2000 }, defaults, 1_000_000)
    assert.equal(zeroDiscount, "  0.00% ZeroCo U\n  In $0.0010 / Out $0.0020\n  Est. In 1000.00M / Out 500.00M")

    const zeroBalance = rowText({ model: "m", discount: 95, provider: "ZeroBal", trusted: true, input: 1000, output: 2000 }, defaults, 0)
    assert.match(zeroBalance, /Est\. In 0\.00M \/ Out 0\.00M/)

    const missingBalance = rowText({ model: "m", discount: 95, provider: "NoBal", trusted: true, input: 1000, output: 2000 }, defaults, undefined)
    assert.match(missingBalance, /Est\. In \?M \/ Out \?M/)

    const missingProvider = rowText({ model: "m", discount: 95, provider: "   ", trusted: true, input: 1000, output: 2000 }, defaults, 1_000_000)
    assert.equal(missingProvider.split("\n")[0], "  95.00% T")

    assert.equal(rowText({ model: "m", discount: -1, text: "Fallback" }, defaults, 100), "Fallback")
    assert.equal(rowText({ model: "m", discount: 105, text: "Too high" }, defaults, 100), "Too high")
    assert.equal(rowText(null, defaults, 100), "")
    assert.ok(sorts.volume && fields.balance)
  })
})

describe("rpc.js", () => {
  it("defines SurplusCost contract shape", () => {
    assert.equal(SurplusCost.id, "surplus-cost")
    assert.deepEqual(SurplusCost.methods.session.input.required, ["sessionID"])
    assert.deepEqual(SurplusCost.methods.session.output.required, [
      "micro",
      "settled",
      "pending",
      "directMicro",
      "comparedMicro",
      "compared",
    ])
    assert.deepEqual(Object.keys(SurplusCost.methods.markets.input.properties).sort(), ["refresh", "sessionID"])
    assert.deepEqual(SurplusCost.methods.markets.input.required, ["sessionID"])
    assert.deepEqual(SurplusCost.methods.markets.output.required, ["rows", "updated"])
    assert.ok("balance" in SurplusCost.methods.markets.output.properties)
  })
})

describe("plugin http.request hook", () => {
  it("upgrades /min95/v1/(chat/completions|completions|responses) when floor > 95", async () => {
    const { hooks } = await setupPlugin({
      fetch: async () => jsonResponse({ depth: { best_live_discount_pct: 98.15 } }),
    })

    for (const endpoint of ["chat/completions", "completions", "responses"]) {
      const event = {
        sessionID: "s1",
        request: new Request(`https://api.surplusintelligence.ai/min95/v1/${endpoint}`, {
          method: "POST",
          headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
          body: JSON.stringify({ model: "test/model", input: "hi" }),
        }),
      }
      await hooks.request(event)
      assert.equal(event.request.url, `https://api.surplusintelligence.ai/min98/v1/${endpoint}`)
      assert.deepEqual(await event.request.json(), { model: "test/model", input: "hi" })
    }
  })

  it("ignores non-Surplus origins without rewriting URL or capturing credentials", async () => {
    const seenHeaders = []
    const { hooks, rpc } = await setupPlugin({
      fetch: async (url, opts) => {
        seenHeaders.push({ url, auth: opts?.headers?.Authorization })
        return jsonResponse({ offers: [] })
      },
    })

    const originalReq = new Request("https://api.openai.com/min95/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer openai-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    })
    const event = { sessionID: "s1", request: originalReq }
    await hooks.request(event)

    assert.equal(event.request, originalReq)
    assert.equal(event.request.url, "https://api.openai.com/min95/v1/chat/completions")

    await rpc.markets({ sessionID: "s1" })
    assert.equal(seenHeaders.some((call) => call.url.endsWith("/v1/payments/balance")), false)
  })

  it("does not downgrade /min95/ when best_live_discount_pct < 95 or === 95", async () => {
    for (const pct of [92.4, 95, 95.9]) {
      const { hooks } = await setupPlugin({
        fetch: async () => jsonResponse({ depth: { best_live_discount_pct: pct } }),
      })
      const originalReq = new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "test/model" }),
      })
      const event = { sessionID: "s1", request: originalReq }
      await hooks.request(event)
      assert.equal(event.request, originalReq)
      assert.equal(new URL(event.request.url).pathname, "/min95/v1/chat/completions")
    }
  })

  it("fails closed on malformed JSON, non-string body.model, and network errors", async () => {
    let fetchCalls = 0
    const { hooks } = await setupPlugin({
      fetch: async () => {
        fetchCalls++
        throw new Error("offline")
      },
    })

    for (const body of ["{not-json", JSON.stringify({ model: 123 }), JSON.stringify({ model: "" }), JSON.stringify({})]) {
      const originalReq = new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", {
        method: "POST",
        body,
      })
      const event = { sessionID: "s1", request: originalReq }
      await hooks.request(event)
      assert.equal(event.request, originalReq)
    }
    assert.equal(fetchCalls, 0)

    const netFailEvent = {
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "test/model" }),
      }),
    }
    await hooks.request(netFailEvent)
    assert.equal(new URL(netFailEvent.request.url).pathname, "/min95/v1/chat/completions")
    assert.equal(fetchCalls, 1)
  })

  it("caches model floor for 20s and deduplicates concurrent in-flight lookups", async () => {
    let time = 100_000
    let floorCalls = 0
    let releaseFirstFetch
    const firstFetchGate = new Promise((resolve) => {
      releaseFirstFetch = resolve
    })

    const { hooks } = await setupPlugin({
      now: () => time,
      fetch: async () => {
        floorCalls++
        if (floorCalls === 1) await firstFetchGate
        return jsonResponse({ depth: { best_live_discount_pct: floorCalls === 1 ? 97.5 : 99.1 } })
      },
    })

    const req1 = {
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m1" }),
      }),
    }
    const req2 = {
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/min95/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "m1" }),
      }),
    }

    const p1 = hooks.request(req1)
    const p2 = hooks.request(req2)
    await flushAsync()
    assert.equal(floorCalls, 1)
    releaseFirstFetch()
    await Promise.all([p1, p2])

    assert.equal(new URL(req1.request.url).pathname, "/min97/v1/chat/completions")
    assert.equal(new URL(req2.request.url).pathname, "/min97/v1/responses")

    // Within 20s TTL: cache hit
    time += 19_999
    const req3 = {
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/min95/v1/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m1" }),
      }),
    }
    await hooks.request(req3)
    assert.equal(floorCalls, 1)
    assert.equal(new URL(req3.request.url).pathname, "/min97/v1/completions")

    // After 20s TTL: cache expired -> fresh lookup
    time += 1
    const req4 = {
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/min95/v1/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m1" }),
      }),
    }
    await hooks.request(req4)
    assert.equal(floorCalls, 2)
    assert.equal(new URL(req4.request.url).pathname, "/min99/v1/completions")
  })
})

describe("plugin http.response hook", () => {
  it("ignores non-OK responses, missing x-request-id, and deduplicates duplicate x-request-id", async () => {
    let reconcileCalls = 0
    const { hooks, store } = await setupPlugin({
      env: { SURPLUS_API_KEY: "env-key" },
      fetch: async () => {
        reconcileCalls++
        return jsonResponse({ settlement_status: "accrued", buyer_cost_micro: 100, direct_cost_micro: 200 })
      },
    })

    await hooks.response({
      sessionID: "s1",
      response: new Response("err", { status: 500, headers: { "x-request-id": "req-err" } }),
    })
    assert.equal(store.size, 0)

    await hooks.response({
      sessionID: "s1",
      response: new Response("ok", { status: 200 }),
    })
    assert.equal(store.size, 0)

    await hooks.response({
      sessionID: "s1",
      response: new Response("ok", { status: 200, headers: { "x-request-id": "req-1" } }),
    })
    await flushAsync()
    assert.equal(reconcileCalls, 1)
    assert.equal(store.get("requests/s1/req-1")?.micro, 100)

    // Duplicate x-request-id must be idempotent
    await hooks.response({
      sessionID: "s1",
      response: new Response("ok", { status: 200, headers: { "x-request-id": "req-1" } }),
    })
    await flushAsync()
    assert.equal(reconcileCalls, 1)
  })
})

describe("plugin reconcile & rpc.session", () => {
  it("reconciles multiple pending records concurrently without starving behind a failing first record", async () => {
    let time = 10_000
    let activeFetches = 0
    let maxConcurrent = 0
    const attempted = []

    const { store, rpc } = await setupPlugin({
      now: () => time,
      env: { SURPLUS_API_KEY: "env-key" },
      fetch: async (url) => {
        const id = url.split("/").pop()
        attempted.push(id)
        activeFetches++
        maxConcurrent = Math.max(maxConcurrent, activeFetches)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activeFetches--
        if (id === "req-0-fail") return new Response("boom", { status: 500 })
        return jsonResponse({ settlement_status: "settled", buyer_cost_micro: 250, direct_cost_micro: 500 })
      },
    })

    store.set("requests/s1/req-0-fail", { requestID: "req-0-fail" })
    store.set("requests/s1/req-1-ok", { requestID: "req-1-ok" })
    store.set("requests/s1/req-2-ok", { requestID: "req-2-ok" })
    store.set("requests/s1/req-3-ok", { requestID: "req-3-ok" })
    store.set("requests/s1/req-4-ok", { requestID: "req-4-ok" })

    const initial = await rpc.session({ sessionID: "s1" })
    assert.equal(initial.pending, 5)
    assert.equal(initial.settled, 0)

    // Wait for concurrent batch (4 workers, 5 items, ~10ms each)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await flushAsync()

    assert.ok(maxConcurrent > 1 && maxConcurrent <= 4, `expected 2..4 concurrent fetches, got ${maxConcurrent}`)

    const afterBatch = await rpc.session({ sessionID: "s1" })
    assert.deepEqual(afterBatch, {
      micro: 1000,
      settled: 4,
      pending: 1,
      directMicro: 2000,
      comparedMicro: 1000,
      compared: 4,
    })

    // Within 5s backoff cooldown, failing record is NOT retried
    attempted.length = 0
    time += 4_999
    await rpc.session({ sessionID: "s1" })
    await flushAsync()
    assert.deepEqual(attempted, [])

    // Once 5s backoff expires, failing record IS retried
    time += 1
    await rpc.session({ sessionID: "s1" })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(attempted, ["req-0-fail"])
  })

  it("handles direct_cost_micro missing vs present, recheck cooldown, finalized status, and max attempts", async () => {
    let time = 50_000
    let callNum = 0
    const { store, rpc } = await setupPlugin({
      now: () => time,
      env: { SURPLUS_API_KEY: "env-key" },
      fetch: async (url) => {
        callNum++
        const id = url.split("/").pop()
        if (id === "req-delayed-direct") {
          return jsonResponse(
            callNum === 1
              ? { settlement_status: "accrued", buyer_cost_micro: 300, direct_cost_micro: null }
              : { settlement_status: "accrued", buyer_cost_micro: 300, direct_cost_micro: 900 },
          )
        }
        if (id === "req-finalized-no-direct") {
          return jsonResponse({ settlement_status: "settled", buyer_cost_micro: 400, direct_cost_micro: null })
        }
        if (id === "req-always-no-direct") {
          return jsonResponse({ settlement_status: "accrued", buyer_cost_micro: 100 })
        }
        throw new Error("unexpected id")
      },
    })

    // 1. Accrued with missing direct_cost_micro -> rechecked after 15s cooldown -> direct_cost_micro arrives
    store.set("requests/s1/req-delayed-direct", { requestID: "req-delayed-direct" })
    await rpc.session({ sessionID: "s1" })
    await flushAsync()
    assert.deepEqual(store.get("requests/s1/req-delayed-direct"), {
      requestID: "req-delayed-direct",
      micro: 300,
      directMicro: null,
      directChecked: false,
      directAttempts: 1,
    })

    time += 10_000
    await rpc.session({ sessionID: "s1" })
    await flushAsync()
    assert.equal(callNum, 1) // still in 15s direct recheck cooldown

    time += 5_000
    await rpc.session({ sessionID: "s1" })
    await flushAsync()
    assert.equal(callNum, 2)
    assert.deepEqual(store.get("requests/s1/req-delayed-direct"), {
      requestID: "req-delayed-direct",
      micro: 300,
      directMicro: 900,
      directChecked: true,
      directAttempts: 2,
    })

    // 2. Finalized status without direct_cost_micro marks directChecked immediately
    store.set("requests/s2/req-finalized-no-direct", { requestID: "req-finalized-no-direct" })
    await rpc.session({ sessionID: "s2" })
    await flushAsync()
    assert.equal(store.get("requests/s2/req-finalized-no-direct")?.directChecked, true)

    // 3. Accrued without direct_cost_micro stops after MAX_DIRECT_ATTEMPTS (5)
    store.set("requests/s3/req-always-no-direct", { requestID: "req-always-no-direct" })
    for (let attempt = 1; attempt <= 6; attempt++) {
      time += 20_000
      await rpc.session({ sessionID: "s3" })
      await flushAsync()
    }
    assert.equal(store.get("requests/s3/req-always-no-direct")?.directAttempts, 5)
    assert.equal(store.get("requests/s3/req-always-no-direct")?.directChecked, true)
  })

  it("cleanup() clears credentials and stops in-flight or subsequent reconcile writes", async () => {
    let releaseFetch
    const fetchGate = new Promise((resolve) => {
      releaseFetch = resolve
    })
    let balanceCalls = 0
    const { hooks, store, rpc, cleanup } = await setupPlugin({
      fetch: async (url) => {
        if (url.includes("/v1/requests/")) {
          await fetchGate
          return jsonResponse({ settlement_status: "settled", buyer_cost_micro: 421, direct_cost_micro: 842 })
        }
        if (url.endsWith("/v1/payments/balance")) {
          balanceCalls++
          return jsonResponse({ credit_balance_usdc: "1000" })
        }
        return jsonResponse({ offers: [] })
      },
    })

    // Capture credential in s1
    await hooks.request({
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/v1/models", {
        headers: { authorization: "Bearer secret-token" },
      }),
    })

    // Trigger reconcile and pause while fetch is in flight
    await hooks.response({
      sessionID: "s1",
      response: new Response("ok", { status: 200, headers: { "x-request-id": "req-inflight" } }),
    })
    await flushAsync()

    // Cleanup before fetch resolves
    cleanup()
    releaseFetch()
    await flushAsync()

    // Record should NOT have received settled micro after cleanup()
    assert.deepEqual(store.get("requests/s1/req-inflight"), { requestID: "req-inflight" })

    // Neither s1 nor new session s2 should have credentials anymore
    await rpc.markets({ sessionID: "s1" })
    await rpc.markets({ sessionID: "s2" })
    assert.equal(balanceCalls, 0)

    // Subsequent rpc.session should not trigger new reconcile writes
    store.set("requests/s1/req-after-cleanup", { requestID: "req-after-cleanup" })
    await rpc.session({ sessionID: "s1" })
    await flushAsync()
    assert.deepEqual(store.get("requests/s1/req-after-cleanup"), { requestID: "req-after-cleanup" })
    assert.deepEqual(await rpc.session({ sessionID: "" }), {
      micro: 0,
      settled: 0,
      pending: 0,
      directMicro: 0,
      comparedMicro: 0,
      compared: 0,
    })
  })
})

describe("plugin marketOffers & rpc.markets", () => {
  it("caches for 60s, supports refresh: true bypass, and deduplicates in-flight requests", async () => {
    let time = 200_000
    let marketFetchCount = 0
    let releaseFirst
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve
    })

    const { hooks, rpc } = await setupPlugin({
      now: () => time,
      fetch: async (url) => {
        if (url.includes("/api/markets/")) {
          marketFetchCount++
          if (marketFetchCount === 1) await firstGate
          return jsonResponse({
            depth: { best_live_discount_pct: 98.15 },
            offers: [
              {
                available: true,
                healthy: true,
                discount_pct: 98.15,
                effective_input_per_1m: 18500,
                effective_output_per_1m: 92500,
                provider: "Test",
                trusted: false,
              },
            ],
          })
        }
        if (url.endsWith("/v1/payments/balance")) {
          return jsonResponse({ credit_balance_usdc: "1850000" })
        }
        throw new Error(`unexpected ${url}`)
      },
    })

    await hooks.request({
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/v1/models", {
        headers: { authorization: "Bearer test-secret" },
      }),
    })

    // Concurrent calls deduplicate in-flight market fetch
    const p1 = rpc.markets({ sessionID: "s1" })
    const p2 = rpc.markets({ sessionID: "s1" })
    await flushAsync()
    assert.equal(marketFetchCount, 1)
    releaseFirst()
    const [m1, m2] = await Promise.all([p1, p2])
    assert.equal(m1.rows.length, 1)
    assert.equal(m2.rows.length, 1)
    assert.match(m1.rows[0].text, /98\.15% Test U/)
    assert.match(m1.rows[0].text, /Est\. In 100\.00M \/ Out 20\.00M/)
    assert.equal(m1.balance, 1850000)

    // Within 60s: uses cached market data
    time += 59_999
    await rpc.markets({ sessionID: "s1" })
    assert.equal(marketFetchCount, 1)

    // refresh: true bypasses cache even within 60s
    await rpc.markets({ sessionID: "s1", refresh: true })
    assert.equal(marketFetchCount, 2)

    // After 60s: cache expires
    time += 60_000
    await rpc.markets({ sessionID: "s1" })
    assert.equal(marketFetchCount, 3)
  })

  it("does not cache all-failed market responses for 60s", async () => {
    let time = 300_000
    let attempt = 0
    const { rpc } = await setupPlugin({
      now: () => time,
      fetch: async () => {
        attempt++
        if (attempt === 1) return new Response("down", { status: 503 })
        return jsonResponse({
          offers: [
            {
              available: true,
              healthy: true,
              discount_pct: 96,
              effective_input_per_1m: 1000,
              effective_output_per_1m: 2000,
              provider: "Recovered",
              trusted: true,
            },
          ],
        })
      },
    })

    const failed = await rpc.markets({ sessionID: "s1" })
    assert.equal(failed.rows[0].text, "Market data unavailable")

    // Immediately retry within 60s — must NOT serve stale failed cache
    time += 1000
    const recovered = await rpc.markets({ sessionID: "s1" })
    assert.equal(attempt, 2)
    assert.match(recovered.rows[0].text, /96\.00% Recovered T/)
  })

  it("resolves credentials in priority order: session > SURPLUS_API_KEY > latestCredential", async () => {
    const authHeaders = []
    const { hooks, rpc, cleanup } = await setupPlugin({
      env: { SURPLUS_API_KEY: "env-key" },
      models: () => [],
      fetch: async (url, opts) => {
        if (url.endsWith("/v1/payments/balance")) {
          authHeaders.push(opts.headers.Authorization)
          return jsonResponse({ credit_balance_usdc: "500000" })
        }
        return jsonResponse({ offers: [] })
      },
    })

    // No session key -> uses env SURPLUS_API_KEY
    await rpc.markets({ sessionID: "s-env" })
    assert.equal(authHeaders.at(-1), "Bearer env-key")

    // Capture session key for s1 -> takes priority over env key
    await hooks.request({
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/v1/models", {
        headers: { authorization: "Bearer s1-key" },
      }),
    })
    await rpc.markets({ sessionID: "s1" })
    assert.equal(authHeaders.at(-1), "Bearer s1-key")
    cleanup()

    // Without SURPLUS_API_KEY env, latestCredential acts as cross-session fallback
    const auth2 = []
    const p2 = await setupPlugin({
      env: {},
      models: () => [],
      fetch: async (url, opts) => {
        if (url.endsWith("/v1/payments/balance")) {
          auth2.push(opts.headers.Authorization)
          return jsonResponse({ credit_balance_usdc: "700000" })
        }
        return jsonResponse({ offers: [] })
      },
    })
    await p2.hooks.request({
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/v1/models", {
        headers: { authorization: "Bearer session-1-key" },
      }),
    })
    const newSessionMarket = await p2.rpc.markets({ sessionID: "s2" })
    assert.equal(auth2.at(-1), "Bearer session-1-key")
    assert.equal(newSessionMarket.balance, 700000)
    p2.cleanup()
  })

  it("handles ctx.model.list() returning array, { data }, or invalid shapes", async () => {
    for (const [shape, expectedCount] of [
      [[{ id: "m1", providerID: "surplus", enabled: true }, { id: "m2", providerID: "other", enabled: true }], 1],
      [{ data: [{ id: "m1", providerID: "surplus", enabled: true }, { id: "m2", providerID: "surplus", enabled: false }] }, 1],
      [null, 0],
      [{ data: "invalid" }, 0],
    ]) {
      const { rpc } = await setupPlugin({
        models: () => shape,
        fetch: async () => jsonResponse({ offers: [] }),
      })
      const res = await rpc.markets({ sessionID: "s1" })
      assert.equal(res.rows.length, expectedCount)
    }
  })

  it("never writes credentials to storage", async () => {
    const { hooks, store, rpc, cleanup } = await setupPlugin({
      fetch: async (url) => {
        if (url.includes("/api/markets/")) {
          return jsonResponse({ depth: { best_live_discount_pct: 98.15 }, offers: [] })
        }
        if (url.endsWith("/v1/payments/balance")) {
          return jsonResponse({ credit_balance_usdc: "100" })
        }
        return jsonResponse({ settlement_status: "accrued", buyer_cost_micro: 10, direct_cost_micro: 20 })
      },
    })

    await hooks.request({
      sessionID: "s1",
      request: new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer super-secret-token" },
        body: JSON.stringify({ model: "test" }),
      }),
    })
    await hooks.response({
      sessionID: "s1",
      response: new Response("ok", { status: 200, headers: { "x-request-id": "req-sec" } }),
    })
    await flushAsync()
    await rpc.markets({ sessionID: "s1" })
    assert.equal(JSON.stringify([...store]).includes("super-secret-token"), false)
    cleanup()
  })
})

describe("default plugin export & tui.tsx transpile", () => {
  it("exports defaultPlugin created via Plugin.define(createSurplusCostPlugin())", async () => {
    assert.equal(defaultPlugin.id, "surplus-cost")
    assert.equal(typeof defaultPlugin.setup, "function")
  })

  it("tui.tsx transpiles cleanly when bun is installed", (t) => {
    const tuiPath = fileURLToPath(new URL("./plugins/surplus-cost/tui.tsx", import.meta.url))
    const res = spawnSync(
      "bun",
      [
        "-e",
        'import { readFileSync } from "node:fs"; const t = new Bun.Transpiler({ loader: "tsx" }); const out = t.transformSync(readFileSync(process.argv[1], "utf8")); if (!out.includes("surplus-cost.tui")) process.exit(1);',
        tuiPath,
      ],
      { encoding: "utf8" },
    )
    if (res.error?.code === "ENOENT") {
      t.skip("bun not installed")
      return
    }
    assert.equal(res.status, 0, res.stderr || res.stdout)
  })
})
