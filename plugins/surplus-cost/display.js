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

export function rowText(row, settings, balance) {
  if (row.discount === undefined) return row.text
  const lines = []
  const heading = [settings.discount ? `${row.discount.toFixed(2)}%` : "", settings.provider ? row.provider : "", settings.trust ? (row.trusted ? "T" : "U") : ""].filter(Boolean).join(" ")
  if (heading) lines.push(heading)
  const price = (v) => v === undefined ? "?" : `$${(v / 1e6).toFixed(4)}`
  const amount = (v) => balance === undefined || v === undefined || v <= 0 ? "?" : (balance / v).toFixed(2)
  if (settings.prices) lines.push(`In ${price(row.input)} / Out ${price(row.output)}`)
  if (settings.estimates) lines.push(`Est. In ${amount(row.input)}M / Out ${amount(row.output)}M`)
  return lines.map((line) => `  ${line}`).join("\n")
}
