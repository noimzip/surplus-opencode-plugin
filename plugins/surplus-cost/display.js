export const defaults = { sort: "discount", provider: true, trust: true, discount: true, prices: true, estimates: true, balance: true }
export const sorts = { discount: "割引率順", input: "入力価格順", output: "出力価格順", model: "モデル名順", volume: "24時間取引額順" }
export const fields = { provider: "プロバイダー", trust: "Trusted / Untrusted", discount: "割引率", prices: "入出力単価", estimates: "利用可能量の目安", balance: "残高" }

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
  if (settings.prices) lines.push(`入 ${price(row.input)} / 出 ${price(row.output)}`)
  if (settings.estimates) lines.push(`目安 入 ${amount(row.input)}M / 出 ${amount(row.output)}M`)
  return lines.map((line) => `  ${line}`).join("\n")
}
