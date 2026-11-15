import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, For } from "solid-js"
import { SurplusCost } from "./rpc.js"
import { defaults, sorts, fields, sortRows, rowText } from "./display.js"

export default Plugin.define({
  id: "surplus-cost.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(SurplusCost)
    const [settings, updateSettings] = ctx.storage.store("surplus-display", { initial: defaults })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "surplus.sort", title: "Surplus: Change sort order", palette: true, run: async () => {
          const chosen = await ctx.ui.dialog.select({ title: "Surplus Sort Order", current: settings.sort, options: Object.entries(sorts).map(([value, title]) => ({ value, title })) })
          if (chosen) await updateSettings((draft) => { draft.sort = chosen })
        } },
        { id: "surplus.fields", title: "Surplus: Change display fields", palette: true, run: async () => {
          const chosen = await ctx.ui.dialog.select({ title: "Surplus Display Fields (select to toggle)", options: Object.entries(fields).map(([value, title]) => ({ value, title: `${settings[value] ? "☑" : "☐"} ${title}` })) })
          if (chosen) await updateSettings((draft) => { draft[chosen] = !draft[chosen] })
        } },
      ],
    }))
    return ctx.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const [value, setValue] = createSignal<{ micro: number; settled: number; pending: number; directMicro: number; comparedMicro: number; compared: number }>()
        const [markets, setMarkets] = createSignal<{ rows: { model: string; text: string; discount?: number; input?: number; output?: number; volume?: number; provider?: string; trusted?: boolean }[]; updated: number; balance?: number }>()
        createEffect(() => {
          const sessionID = props.sessionID
          let active = true
          let busy = false
          setValue(undefined)
          const refresh = async () => {
            if (!sessionID || busy) return
            busy = true
            try {
              const result = await rpc.session({ sessionID })
              if (active) setValue(result)
            } catch {
              if (active) setValue(undefined)
            } finally { busy = false }
          }
          void refresh()
          const timer = setInterval(refresh, 5000)
          onCleanup(() => { active = false; clearInterval(timer) })
        })
        createEffect(() => {
          const sessionID = props.sessionID
          let active = true, busy = false
          setMarkets(undefined)
          const refresh = async () => {
            if (busy || !sessionID) return
            busy = true
            try { const result = await rpc.markets({ sessionID }); if (active) setMarkets(result) } catch { if (active) setMarkets(undefined) } finally { busy = false }
          }
          void refresh()
          const timer = setInterval(refresh, 60000)
          onCleanup(() => { active = false; clearInterval(timer) })
        })
        return <box flexDirection="column">
          <text fg={ctx.theme.text.muted}>{!value() ? "Surplus cost: Loading" : !value()!.settled && !value()!.pending ? "Surplus cost: None recorded" : `Surplus cost: $${(value()!.micro / 1_000_000).toFixed(6)} (${value()!.settled} settled${value()!.pending ? ` / ${value()!.pending} pending` : ""})\n${value()!.compared ? `vs. direct: ${((1 - value()!.comparedMicro / value()!.directMicro) * 100).toFixed(1)}% saved${value()!.compared < value()!.settled ? ` (${value()!.compared}/${value()!.settled})` : ""}` : "vs. direct: Unknown"}`}</text>
          <text fg={ctx.theme.text.muted}>{`${settings.balance ? `\nBalance: ${markets()?.balance === undefined ? "Unknown" : `$${(markets()!.balance! / 1e6).toFixed(4)}`}` : ""}\nSurplus Max Discount (USD/1M)\n${sorts[settings.sort] ?? sorts.discount}${settings.estimates ? "\nEst. assumes all-in or all-out" : ""}`}</text>
          <For each={markets() ? sortRows(markets()!.rows, settings.sort) : undefined} fallback={<text fg={ctx.theme.text.muted}>Loading market data</text>}>
            {(row) => <text fg={row.discount === undefined ? ctx.theme.text.muted : row.discount > 95 ? "#00cc66" : row.discount >= 90 ? "#e6c200" : "#ff5555"}>{`\n${row.model}${rowText(row, settings, markets()?.balance) ? `\n${rowText(row, settings, markets()?.balance)}` : ""}`}</text>}
          </For>
        </box>
      },
    })
  },
})
