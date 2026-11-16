import { formatMtok, formatUsdMicro } from "./core.js"

export const defaults = { sort: "discount", provider: true, trust: true, discount: true, prices: true, estimates: true, balance: true }
export const sorts = { discount: "By discount", input: "By input price", output: "By output price", model: "By model name", volume: "By 24h volume" }
export const fields = { provider: "Provider", trust: "Trusted / Untrusted", discount: "Discount", prices: "Input/Output prices", estimates: "Available tokens estimate", balance: "Balance" }

export function sortRows(rows, sort) {
  return [...rows].sort((a, b) => {
    if (sort === "model") return a.model.localeCompare(b.model)
    const key = ["discount", "input", "output", "volume"].includes(sort) ? sort : "discount"
    const x = a[key], y = b[key]
    const ax = typeof x === "number" && Number.isFinite(x), by = typeof y === "number" && Number.isFinite(y)
    if (!ax || !by) return ax ? -1 : by ? 1 : a.model.localeCompare(b.model)
    return (key === "input" || key === "output" ? x - y : y - x) || a.model.localeCompare(b.model)
  })
}

export function rowText(row, settings = defaults, balance) {
  if (!row || typeof row.discount !== "number" || !Number.isFinite(row.discount) || row.discount < 0 || row.discount > 100) {
    return typeof row?.text === "string" ? row.text : ""
  }
  const opts = settings ?? defaults
  const provider = typeof row.provider === "string" ? row.provider.trim() : ""
  const lines = []
  const heading = [
    opts.discount ? `${row.discount.toFixed(2)}%` : "",
    opts.provider ? provider : "",
    opts.trust ? (row.trusted ? "T" : "U") : "",
  ].filter(Boolean).join(" ")
  if (heading) lines.push(heading)
  if (opts.prices) lines.push(`In ${formatUsdMicro(row.input)} / Out ${formatUsdMicro(row.output)}`)
  if (opts.estimates) lines.push(`Est. In ${formatMtok(balance, row.input)}M / Out ${formatMtok(balance, row.output)}M`)
  return lines.map((line) => `  ${line}`).join("\n")
}
