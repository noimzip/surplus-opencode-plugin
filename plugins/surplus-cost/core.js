// Surplus reports charges as integer microdollars. Never infer a charge from a price.
export function validMicro(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null
  const amount = Number(value)
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null
}

export function affordableMtok(balance, price) {
  const funds = validMicro(balance)
  const rate = validMicro(price)
  return funds === null || rate === null || rate === 0 ? null : funds / rate
}

export function formatUsdMicro(micro) {
  const valid = validMicro(micro)
  return valid === null ? "?" : `$${(valid / 1e6).toFixed(4)}`
}

export function formatMtok(balance, micro) {
  const amount = affordableMtok(balance, micro)
  return amount === null ? "?" : amount.toFixed(2)
}

export function sortByVolume(rows) {
  return [...rows].sort((a, b) => {
    const av = validMicro(a.volume), bv = validMicro(b.volume)
    if (av === null) return bv === null ? 0 : 1
    if (bv === null) return -1
    return bv - av
  })
}

export function bestDiscountFloor(market) {
  const value = market?.depth?.best_live_discount_pct
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.floor(value)
    : null
}

export function bestOffer(market) {
  if (!Array.isArray(market?.offers)) return null
  const eligible = market.offers.filter(
    (offer) =>
      offer &&
      offer.available === true &&
      offer.healthy === true &&
      typeof offer.discount_pct === "number" &&
      Number.isFinite(offer.discount_pct) &&
      offer.discount_pct >= 0 &&
      offer.discount_pct <= 100
  )
  eligible.sort((a, b) => b.discount_pct - a.discount_pct || (a.rank ?? Infinity) - (b.rank ?? Infinity))
  const offer = eligible[0]
  if (!offer) return null
  return {
    discount: offer.discount_pct,
    input: validMicro(offer.effective_input_per_1m),
    output: validMicro(offer.effective_output_per_1m),
    provider: typeof offer.provider === "string" ? offer.provider : "?",
    trusted: offer.trusted === true,
  }
}

export function settledMicro(row) {
  if (!row || !["accrued", "settled", "confirmed", "completed", "paid"].includes(row.settlement_status)) return null
  return validMicro(row.buyer_cost_micro)
}

export function summarize(records) {
  let micro = 0, settled = 0, pending = 0, directMicro = 0, comparedMicro = 0, compared = 0
  for (const record of records) {
    if (Number.isSafeInteger(record.micro) && record.micro >= 0) {
      micro += record.micro
      settled++
      if (Number.isSafeInteger(record.directMicro) && record.directMicro > 0) {
        directMicro += record.directMicro
        comparedMicro += record.micro
        compared++
      }
    } else pending++
  }
  return { micro, settled, pending, directMicro, comparedMicro, compared }
}
