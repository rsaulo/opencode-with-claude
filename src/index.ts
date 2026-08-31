import { randomUUID } from "node:crypto"

import { Plugin } from "@opencode-ai/plugin"
import { scrubOpencodeFingerprints } from "@rynfar/meridian-plugin-opencode-scrub"

import { createLogger } from "./logger"
import {
  loadMeridianConfig,
  summarizeMeridianConfig,
} from "./meridian-config"
import {
  acquireSharedProxy,
  checkSharedProxyHealth,
  getProxyBaseURL,
  releaseSharedProxy,
} from "./proxy"

export default Plugin.define({
  id: "opencode-with-claude",
  setup: async (ctx) => {
    const log = createLogger()
    const agentModes = new Map<string, string>()

    const meridianConfig = loadMeridianConfig(log)
    const summary = summarizeMeridianConfig(meridianConfig)
    if (summary) void log("info", summary)

    const port = process.env.CLAUDE_PROXY_PORT || 3456
    const proxy = await acquireSharedProxy({
      port,
      log,
      profiles: meridianConfig.profiles,
      defaultProfile: meridianConfig.defaultProfile,
    })

    const baseURL = getProxyBaseURL(proxy.port)
    void log("info", `proxy ready at ${baseURL}`)

    // Diagnostic only. One shot for the process — not per location.
    checkSharedProxyHealth(proxy.port, log)

    await ctx.agent.transform((agents) => {
      for (const agent of agents.list()) {
        agentModes.set(agent.id.toLowerCase(), agent.mode)
        agentModes.set(agent.name.toLowerCase(), agent.mode)
      }
    })

    await ctx.catalog.transform((catalog) => {
      catalog.provider.update("anthropic", (provider) => {
        ;(provider.settings ??= {}).baseURL = baseURL
      })
    })

    await ctx.session.hook("context", (event) => {
      if (event.model.providerID !== "anthropic") return

      const systemContext = event.system.map((part) => part.text).join("\n\n")
      const scrubbed = scrubOpencodeFingerprints(systemContext)
      if (scrubbed !== systemContext) {
        event.system.splice(0, event.system.length, {
          type: "text",
          text: scrubbed,
        })
      }
    })

    await ctx.session.hook("http.request", (event) => {
      if (event.model.providerID !== "anthropic") return

      event.request.headers.delete("anthropic-beta")
      const agentName =
        String(event.agent ?? "unknown").replace(/[^\x20-\x7E]/g, "").trim() ||
        "unknown"

      event.request.headers.set("x-opencode-session", event.sessionID)
      event.request.headers.set(
        "x-opencode-request",
        event.request.headers.get("x-opencode-request") ?? randomUUID(),
      )
      event.request.headers.set(
        "x-opencode-agent-mode",
        agentModes.get(agentName.toLowerCase()) ?? "primary",
      )
      event.request.headers.set("x-opencode-agent-name", agentName)
    })

    // Drop this location's claim only. The listener stays up while any
    // other location still holds it.
    return () => releaseSharedProxy()
  },
})
