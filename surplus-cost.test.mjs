import { strict as assert } from "node:assert"
import { settledMicro, summarize, validMicro, bestDiscountFloor, bestOffer, affordableMtok, sortByVolume } from "./plugins/surplus-cost/core.js"
import { readFile } from "node:fs/promises"
import { defaults, sortRows, rowText } from "./plugins/surplus-cost/display.js"

assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: 1234 }), 1234)
assert.equal(settledMicro({ settlement_status: "settled", buyer_cost_micro: "0" }), 0)
assert.equal(settledMicro({ settlement_status: "pending", buyer_cost_micro: 1234 }), null)
assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: null }), null)
assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: -1 }), null)
assert.equal(settledMicro({ settlement_status: "accrued", buyer_cost_micro: "1.5" }), null)
assert.deepEqual(summarize([{ micro: 100, directMicro: 200 }, { micro: 0, directMicro: 0 }, {}]), { micro: 100, settled: 2, pending: 1, directMicro: 200, comparedMicro: 100, compared: 1 })
assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: 98.15 } }), 98)
assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: null } }), null)
assert.equal(bestDiscountFloor({ depth: { best_live_discount_pct: 101 } }), null)
assert.equal(bestOffer({ offers: [{ available: false, healthy: true, discount_pct: 99 }, { available: true, healthy: true, discount_pct: 98, effective_input_per_1m: 123, effective_output_per_1m: 456, cap_remaining: null }] }).input, 123)
assert.equal(bestOffer({ offers: [] }), null)
assert.equal(affordableMtok("1000000", 500000), 2)
assert.equal(affordableMtok(0, 500000), 0)
assert.equal(affordableMtok(null, 500000), null)
assert.equal(affordableMtok(100, 0), null)
const sampleRows = [{ model: "b", discount: 92, input: 10, output: 50, volume: 3 }, { model: "a", discount: 99, input: 20, output: 5, volume: 9 }, { model: "z", text: "不明" }]
for (const [sort, expected] of Object.entries({ discount: ["a", "b", "z"], input: ["b", "a", "z"], output: ["a", "b", "z"], model: ["a", "b", "z"], volume: ["a", "b", "z"] })) assert.deepEqual(sortRows(sampleRows, sort).map((row) => row.model), expected)
assert.match(rowText({ ...sampleRows[0], provider: "Test", trusted: true }, defaults, 100), /92\.00% Test T/)
assert.doesNotMatch(rowText({ ...sampleRows[0], provider: "Test", trusted: true }, { ...defaults, provider: false, prices: false }, 100), /Test|入 \$/)
assert.deepEqual(sortByVolume([{model:"missing"}, {model:"low",volume:0}, {model:"high",volume:"123"}, {model:"mid",volume:5}]).map(x => x.model), ["high", "mid", "low", "missing"])
const store = new Map()
const hooks = {}
let rpc
globalThis.__surplusTest = { Plugin: { define: (x) => x }, SurplusCost: {}, settledMicro, summarize, validMicro, bestDiscountFloor, bestOffer, affordableMtok, sortByVolume }
const source = (await readFile(new URL("./plugins/surplus-cost/index.js", import.meta.url), "utf8"))
  .replace(/^import .*$/gm, "")
  .replace('const API =', 'const { Plugin, SurplusCost, settledMicro, summarize, validMicro, bestDiscountFloor, bestOffer, affordableMtok, sortByVolume } = globalThis.__surplusTest\nconst API =')
const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
const oldFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (url.startsWith("https://api.surplusintelligence.ai/api/markets/")) return new Response(JSON.stringify({ depth: { best_live_discount_pct: 98.15 }, offers: [{ available: true, healthy: true, discount_pct: 98.15, effective_input_per_1m: 18500, effective_output_per_1m: 92500, cap_remaining: 100, provider: "Test", trusted: false }] }))
  if (url === "https://api.surplusintelligence.ai/v1/payments/balance") { assert.equal(options.headers.Authorization, "Bearer test-secret"); return new Response(JSON.stringify({ credit_balance_usdc: "1850000" })) }
  assert.equal(url, "https://api.surplusintelligence.ai/v1/requests/request-1")
  assert.equal(options.headers.Authorization, "Bearer test-secret")
  return new Response(JSON.stringify({ settlement_status: "accrued", buyer_cost_micro: 421, direct_cost_micro: 842 }))
}
const ctx = {
  model: { list: async () => ({ data: [{ id: "test", providerID: "surplus", enabled: true }] }) },
  session: { hook: async (name, fn) => { hooks[name] = fn } },
  storage: {
    get: async (k) => store.get(k),
    set: async (k, v) => store.set(k, v),
    scan: async ({ prefix }) => ({ entries: [...store].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
  },
  rpc: { register: async (_contract, methods) => { rpc = methods } },
}
const cleanup = await plugin.setup(ctx)
const event = { sessionID: "s1", request: new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer test-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "test/model", messages: [] }) }) }
await hooks["http.request"](event)
assert.equal(event.request.url, "https://api.surplusintelligence.ai/min98/v1/chat/completions")
assert.equal((await event.request.json()).model, "test/model")
const failed = { sessionID: "s1", request: new Request("https://api.surplusintelligence.ai/min95/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "test" }) }) }
const workingFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error("offline") }
await hooks["http.request"](failed)
assert.equal(new URL(failed.request.url).pathname, "/min95/v1/chat/completions")
globalThis.fetch = workingFetch
await hooks["http.response"]({ sessionID: "s1", response: new Response("", { headers: { "x-request-id": "request-1" } }) })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(await rpc.session({ sessionID: "s1" }), { micro: 421, settled: 1, pending: 0, directMicro: 842, comparedMicro: 421, compared: 1 })
assert.deepEqual(await rpc.session({ sessionID: "other" }), { micro: 0, settled: 0, pending: 0, directMicro: 0, comparedMicro: 0, compared: 0 })
const marketResult = await rpc.markets({ sessionID: "s1" })
assert.equal(marketResult.rows.length, 1)
assert.match(marketResult.rows[0].text, /98\.15% Test U/)
assert.match(marketResult.rows[0].text, /目安 入 100\.00M \/ 出 20\.00M/)
assert.equal(marketResult.balance, 1850000)
assert.doesNotMatch(marketResult.rows[0].text, /残枠/)
assert.equal(JSON.stringify([...store]).includes("test-secret"), false)
cleanup()
globalThis.fetch = oldFetch
delete globalThis.__surplusTest
console.log("surplus-cost: accounting and hook integration assertions passed")
