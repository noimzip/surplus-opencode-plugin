import { Rpc } from "@opencode/plugin/rpc"

export const SurplusCost = Rpc.define({
  id: "surplus-cost",
  methods: {
    session: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { micro: { type: "number" }, settled: { type: "number" }, pending: { type: "number" }, directMicro: { type: "number" }, comparedMicro: { type: "number" }, compared: { type: "number" } }, required: ["micro", "settled", "pending", "directMicro", "comparedMicro", "compared"], additionalProperties: false },
    },
    markets: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { model: { type: "string" }, text: { type: "string" }, discount: { type: "number" }, input: { type: "number" }, output: { type: "number" }, volume: { type: "number" }, provider: { type: "string" }, trusted: { type: "boolean" } }, required: ["model", "text"], additionalProperties: false } }, updated: { type: "number" }, balance: { type: "number" } }, required: ["rows", "updated"], additionalProperties: false },
    },
  },
  events: {},
})
