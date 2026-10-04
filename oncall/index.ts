import { cron, defineApp, router } from "apps";
import { requirements } from "./context.ts";
import { appendTurn, lastLocation, morningBrief, notify, recentTurns } from "./operations.ts";
import { telegramMessages } from "./webhooks.ts";
import { reply } from "./workflows.ts";

/** A Telegram on-call agent: Executor holds the credentials, tools, approvals, storage and schedule. */
export default defineApp(requirements, {
  tools: router(
    {
      notify,
      morningBrief,
      // Workflows may only run queries and mutations registered here.
      history: router({ recent: recentTurns, append: appendTurn, location: lastLocation }),
    },
    {
      title: "On-call",
      description: "Telegram on-call agent. Use notify to message the owner on Telegram.",
    },
  ),
  workflows: { reply },
  webhooks: { telegramMessages },
  schedules: {
    morning: cron({ expression: "0 8 * * *", timezone: "Africa/Addis_Ababa" }, morningBrief, {}),
  },
});
