import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, For } from "solid-js"
import { SurplusCost } from "./rpc.js"
import { defaults, sorts, fields, sortRows, rowText } from "./display.js"

type SessionValue = {
  micro: number
  settled: number
  pending: number
  directMicro: number
  comparedMicro: number
  compared: number
}

type MarketRow = {
  model: string
  text: string
  discount?: number
  input?: number
  output?: number
  volume?: number
  provider?: string
  trusted?: boolean
}

type MarketData = {
  rows: MarketRow[]
  updated: number
  balance?: number
}

function mutedColor(theme: any) {
  return theme?.text?.muted ?? theme?.muted
}

function errorColor(theme: any) {
  return theme?.text?.error ?? theme?.error ?? theme?.status?.error ?? theme?.text?.danger ?? theme?.danger ?? mutedColor(theme)
}

function discountColor(theme: any, discount: number | undefined) {
  if (typeof discount !== "number" || !Number.isFinite(discount) || discount < 0 || discount > 100) {
    return mutedColor(theme)
  }
  if (discount > 95) {
    return theme?.text?.success ?? theme?.success ?? theme?.status?.success ?? theme?.text?.accent ?? theme?.accent ?? theme?.text?.primary
  }
  if (discount >= 90) {
    return theme?.text?.warning ?? theme?.warning ?? theme?.status?.warning ?? theme?.text?.secondary ?? mutedColor(theme)
  }
  return errorColor(theme)
}

function formatSessionCost(value: SessionValue | undefined, sessionID: string | undefined, sessionError: boolean) {
  if (!sessionID) return "Surplus cost: No active session"
  if (!value) return sessionError ? "Surplus cost: Unavailable (error)" : "Surplus cost: Loading"
  const stale = sessionError ? " [stale]" : ""
  if (!value.settled && !value.pending) return `Surplus cost: None recorded${stale}`
  const pendingText = value.pending ? ` / ${value.pending} pending` : ""
  const costLine = `Surplus cost: $${(value.micro / 1_000_000).toFixed(6)} (${value.settled} settled${pendingText})${stale}`
  let directLine = "vs. direct: Unknown"
  if (value.compared > 0 && value.directMicro > 0) {
    const pct = (1 - value.comparedMicro / value.directMicro) * 100
    const comparison = pct >= 0
      ? `${Math.max(0, pct).toFixed(1)}% saved`
      : `${Math.abs(pct).toFixed(1)}% higher`
    const suffix = value.compared < value.settled ? ` (${value.compared}/${value.settled})` : ""
    directLine = `vs. direct: ${comparison}${suffix}`
  }
  return `${costLine}\n${directLine}`
}

function formatUpdatedTime(updated: number | undefined) {
  if (typeof updated !== "number" || !Number.isFinite(updated) || updated <= 0) return undefined
  return new Date(updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function formatMarketsHeader(settings: typeof defaults, markets: MarketData | undefined, marketsError: boolean) {
  const lines: string[] = []
  if (settings.balance) {
    const balance = markets?.balance
    const balanceText = typeof balance === "number" && Number.isFinite(balance)
      ? `$${(balance / 1e6).toFixed(4)}`
      : "Unknown"
    lines.push(`\nBalance: ${balanceText}`)
  }
  lines.push("Surplus Max Discount (USD/1M)")
  lines.push(sorts[settings.sort as keyof typeof sorts] ?? sorts.discount)
  const updatedText = formatUpdatedTime(markets?.updated)
  if (updatedText) {
    lines.push(`Updated ${updatedText}${marketsError ? " (stale)" : ""}`)
  } else if (marketsError) {
    lines.push("Market refresh failed")
  }
  if (settings.estimates) lines.push("Est. assumes all-in or all-out")
  return lines.join("\n")
}

function marketFallbackText(markets: MarketData | undefined, sessionID: string | undefined, marketsError: boolean) {
  if (markets && markets.rows.length === 0) return "No enabled surplus models"
  if (!sessionID) return "No active session"
  if (marketsError) return "Market data unavailable (error)"
  return "Loading market data"
}

export default Plugin.define({
  id: "surplus-cost.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(SurplusCost)
    const [settings, updateSettings] = ctx.storage.store("surplus-display", { initial: defaults })
    let triggerRefresh: (() => Promise<void>) | undefined

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "surplus.sort",
          title: "Surplus: Change sort order",
          palette: true,
          run: async () => {
            const chosen = await ctx.ui.dialog.select({
              title: "Surplus Sort Order",
              current: settings.sort,
              options: Object.entries(sorts).map(([value, title]) => ({ value, title })),
            })
            if (chosen) await updateSettings((draft) => { draft.sort = chosen })
          },
        },
        {
          id: "surplus.fields",
          title: "Surplus: Change display fields",
          palette: true,
          run: async () => {
            let current: string | undefined
            while (true) {
              const chosen = await ctx.ui.dialog.select({
                title: "Surplus Display Fields (select to toggle, Esc to close)",
                ...(current ? { current } : {}),
                options: Object.entries(fields).map(([value, title]) => ({
                  value,
                  title: `${settings[value] ? "☑" : "☐"} ${title}`,
                })),
              })
              if (!chosen || !(chosen in fields)) break
              current = chosen
              await updateSettings((draft) => { draft[chosen] = !draft[chosen] })
            }
          },
        },
        {
          id: "surplus.refresh",
          title: "Surplus: Refresh",
          palette: true,
          run: async () => {
            await triggerRefresh?.()
          },
        },
      ],
    }))

    return ctx.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const [value, setValue] = createSignal<SessionValue>()
        const [sessionError, setSessionError] = createSignal(false)
        const [markets, setMarkets] = createSignal<MarketData>()
        const [marketsError, setMarketsError] = createSignal(false)

        let activeSessionRefresh: ((opts?: { force?: boolean }) => Promise<void>) | undefined
        let activeMarketRefresh: ((opts?: { force?: boolean; bypassCache?: boolean }) => Promise<void>) | undefined

        const runManualRefresh = async () => {
          await Promise.all([
            activeSessionRefresh?.({ force: true }),
            activeMarketRefresh?.({ force: true, bypassCache: true }),
          ])
        }
        triggerRefresh = runManualRefresh
        onCleanup(() => {
          if (triggerRefresh === runManualRefresh) triggerRefresh = undefined
        })

        createEffect(() => {
          const sessionID = props.sessionID
          let active = true
          let busy = false
          let seq = 0
          let prevSettled: number | undefined
          setValue(undefined)
          setSessionError(false)
          const refresh = async ({ force = false } = {}) => {
            if (!sessionID) return
            if (!force && busy) return
            const id = ++seq
            busy = true
            try {
              const result = await rpc.session({ sessionID })
              if (active && id === seq) {
                const settledIncreased = prevSettled !== undefined && result.settled > prevSettled
                prevSettled = result.settled
                setValue(result)
                setSessionError(false)
                if (settledIncreased) {
                  void activeMarketRefresh?.({ force: true, bypassCache: false })
                }
              }
            } catch {
              if (active && id === seq) setSessionError(true)
            } finally {
              if (id === seq) busy = false
            }
          }
          activeSessionRefresh = refresh
          void refresh({ force: true })
          const timer = setInterval(() => void refresh(), 5000)
          onCleanup(() => {
            active = false
            if (activeSessionRefresh === refresh) activeSessionRefresh = undefined
            clearInterval(timer)
          })
        })

        createEffect(() => {
          const sessionID = props.sessionID
          let active = true
          let busy = false
          let seq = 0
          setMarketsError(false)
          const refresh = async ({ force = false, bypassCache = false } = {}) => {
            if (!sessionID) return
            if (!force && busy) return
            const id = ++seq
            busy = true
            try {
              const result = await (rpc.markets as (args: { sessionID: string; refresh?: boolean }) => Promise<MarketData>)(
                bypassCache ? { sessionID, refresh: true } : { sessionID },
              )
              if (active && id === seq) {
                setMarkets(result)
                setMarketsError(false)
              }
            } catch {
              if (active && id === seq) setMarketsError(true)
            } finally {
              if (id === seq) busy = false
            }
          }
          activeMarketRefresh = refresh
          void refresh({ force: true })
          const timer = setInterval(() => void refresh(), 60000)
          onCleanup(() => {
            active = false
            if (activeMarketRefresh === refresh) activeMarketRefresh = undefined
            clearInterval(timer)
          })
        })

        const sortedRows = createMemo(() => {
          const m = markets()
          return m ? sortRows(m.rows, settings.sort) : undefined
        })

        return (
          <box flexDirection="column">
            <text fg={sessionError() && !value() ? errorColor(ctx.theme) : mutedColor(ctx.theme)}>
              {formatSessionCost(value(), props.sessionID, sessionError())}
            </text>
            <text fg={mutedColor(ctx.theme)}>
              {formatMarketsHeader(settings, markets(), marketsError())}
            </text>
            <For
              each={sortedRows()}
              fallback={
                <text fg={marketsError() && !markets() ? errorColor(ctx.theme) : mutedColor(ctx.theme)}>
                  {marketFallbackText(markets(), props.sessionID, marketsError())}
                </text>
              }
            >
              {(row) => {
                const line = createMemo(() => {
                  const detail = rowText(row, settings, markets()?.balance)
                  return detail ? `\n${row.model}\n${detail}` : `\n${row.model}`
                })
                return <text fg={discountColor(ctx.theme, row.discount)}>{line()}</text>
              }}
            </For>
          </box>
        )
      },
    })
  },
})
