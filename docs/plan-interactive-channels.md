# Interactive Messaging Channels — Implementation Plan

## Background

Feishu (Lark) is now integrated as a fully interactive channel (WebSocket bot + notifications with
clickable buttons). The goal is to bring the same capability to Slack, Telegram, and WhatsApp —
**all without requiring a public URL** — using the same outbound-connection pattern as Feishu.

Research source: https://docs.openclaw.ai/channels (OpenClaw architecture study)

---

## Key Insight: No Public URL Needed

All three channels can work via outbound connections only:

| Channel | Method | Library | Buttons? |
|---------|--------|---------|----------|
| Feishu  | Official SDK WebSocket (done) | `@larksuiteoapi/node-sdk` | ✅ Interactive cards |
| Slack   | Socket Mode (WebSocket to Slack) | `@slack/bolt` | ✅ Block Kit buttons |
| Telegram | Long-polling | `grammy` | ✅ Inline keyboard buttons |
| WhatsApp | Baileys (WhatsApp Web WS) | `baileys` | ❌ Text replies only (free, no Twilio) |

WhatsApp via Baileys replaces the current Twilio-based `WhatsAppNotifier`. Twilio requires a public
webhook URL and has no interactive button support. Baileys is free and works fully offline.

---

## Architecture Pattern (mirrors Feishu)

Each channel gets:
1. **`<Channel>Notifier`** — one-way push, no persistent connection. Used by `AgentManager` and
   `MetaAgentManager` for event-driven alerts (waiting_input, task failed, pipeline complete).
2. **`<Channel>Service`** — stateful two-way bot. WebSocket/polling connection, handles commands
   (`/list`, `/attach`, `/detach`, `/stop`, `/status`, `/help`), forwards text to agents, sends
   interactive cards/buttons for choices.

Both share the same `AgentManager` event listeners and debounce pattern already established in
`FeishuService`.

---

## Tasks

### 1. Slack (highest priority — full button support)

**Library:** `@slack/bolt` with Socket Mode
**Setup:** Create a Slack App → enable Socket Mode → get App-Level Token (`xapp-...`) and Bot Token (`xoxb-...`)

**Notifier (`SlackNotifier` upgrade or new `SlackBoltNotifier`):**
- Replace current `SlackNotifier` (Incoming Webhooks, send-only) with Bolt-based sender
- Keep backward compat: if only `SLACK_WEBHOOK_URL` set → old behavior; if `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN` set → use Bolt
- Send Block Kit messages with button actions for `waiting_input`

**Service (`SlackService`):**
- `App` in Socket Mode: `new App({ token, appToken, socketMode: true })`
- Handle `app.message()` for commands and free text
- Handle `app.action()` for button clicks (choice actions)
- Chat-to-agent binding (same pattern as `FeishuService`)
- Send Block Kit cards that update in-place via `chat.update`

**Block Kit card structure:**
```json
{
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Agent Name* [Running]" } },
    { "type": "divider" },
    { "type": "section", "text": { "type": "mrkdwn", "text": "...messages..." } },
    { "type": "actions", "elements": [
      { "type": "button", "text": { "type": "plain_text", "text": "Yes" }, "value": "yes", "action_id": "choice_yes" }
    ]}
  ]
}
```

**Env vars:**
```
SLACK_APP_TOKEN=xapp-...       # Socket Mode token
SLACK_BOT_TOKEN=xoxb-...       # Bot OAuth token
SLACK_ADMIN_CHANNEL=C...       # Channel ID for pipeline notifications (optional)
```

**Files to create/modify:**
- `server/src/services/SlackBoltNotifier.ts` (new)
- `server/src/services/SlackService.ts` (new)
- `server/src/config.ts` (add slack bolt fields)
- `server/src/index.ts` (wire up)
- `server/__tests__/SlackService.test.ts` (new)
- `server/__tests__/SlackBoltNotifier.test.ts` (new)

---

### 2. Telegram (second priority — buttons + long-polling)

**Library:** `grammy` (TypeScript-first Telegram bot framework)
**Setup:** Create bot via @BotFather → get token

**Notifier (`TelegramNotifier`):**
- Send messages to configured `TELEGRAM_ADMIN_CHAT_ID`
- For `waiting_input`: send message with inline keyboard buttons

**Service (`TelegramService`):**
- `new Bot(token)` with `bot.start()` (long-polling, no public URL)
- Handle commands: `/list`, `/attach`, `/detach`, `/stop`, `/status`, `/help`
- Handle `bot.on('callback_query')` for button clicks
- Chat-to-agent binding (same pattern)
- Edit messages in place (`editMessageText`) for live card updates

**Inline keyboard for choices:**
```typescript
{
  reply_markup: {
    inline_keyboard: [[
      { text: 'Yes', callback_data: JSON.stringify({ action: 'choice', agentId, choice: 'Yes' }) },
      { text: 'No',  callback_data: JSON.stringify({ action: 'choice', agentId, choice: 'No'  }) },
    ]]
  }
}
```

Note: Telegram callback_data is limited to 64 bytes — store agentId + choice only, resolve chatId from context.

**Env vars:**
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ADMIN_CHAT_ID=...     # numeric chat ID for pipeline notifications
TELEGRAM_ALLOWED_USERS=...     # comma-separated numeric user IDs (optional)
```

**Files to create/modify:**
- `server/src/services/TelegramNotifier.ts` (new)
- `server/src/services/TelegramService.ts` (new)
- `server/src/config.ts`
- `server/src/index.ts`
- `server/__tests__/TelegramService.test.ts` (new)
- `server/__tests__/TelegramNotifier.test.ts` (new)

---

### 3. WhatsApp via Baileys (replace Twilio — no buttons, but free + no public URL)

**Library:** `baileys` (WhatsApp Web reverse-engineering, Node.js)
**Setup:** First run shows QR code → scan with WhatsApp app → session persists to disk

**Key differences from Twilio:**
- Free — no API costs
- No public URL required
- No button support (WhatsApp Business API buttons are Twilio/Meta Cloud API only)
- Users reply with text: "1" or "Yes" instead of clicking

**Notifier (`WhatsAppBaileysNotifier`):**
- Replace `WhatsAppNotifier` (Twilio) or run alongside
- Send text message with numbered choices when `waiting_input`
  e.g. "Agent needs input:\n1. Yes\n2. No\n3. Always allow\nReply with number or text."

**Service (`WhatsAppService`):**
- Persistent Baileys socket with auto-reconnect
- QR code printed to stdout on first run (or served as PNG via `/api/whatsapp/qr`)
- Handle inbound messages: commands + free text forwarding
- Phone-to-agent binding (same pattern)

**Caveats to document:**
- Baileys is unofficial — WhatsApp can ban accounts using automation
- Only works with personal WhatsApp accounts (not Business API)
- Session files stored in `data/whatsapp_session/`

**Env vars:**
```
WHATSAPP_ADMIN_PHONE=+1234567890   # E.164 format, for pipeline notifications
WHATSAPP_ALLOWED_PHONES=...        # comma-separated (optional)
```

**Files to create/modify:**
- `server/src/services/WhatsAppBaileysService.ts` (new)
- `server/src/services/WhatsAppBaileysNotifier.ts` (new — wraps service for one-way push)
- `server/src/config.ts`
- `server/src/index.ts`
- Keep old `WhatsAppNotifier` (Twilio) for users who prefer it; new Baileys service is opt-in
- `server/__tests__/WhatsAppBaileysService.test.ts` (new)

---

## Common Patterns Across All Channels

All services should follow the `FeishuService` pattern:

```
FeishuService / SlackService / TelegramService / WhatsAppService
  ├── constructor(cfg, agentManager)
  ├── start() / stop() / isStarted()
  ├── getBindings() → Map<chatId, { agentId, cardMessageId?, pendingChoices? }>
  ├── handleMessage(event) → command router + free text forwarding
  ├── handleInteraction(event) → button click handler
  ├── scheduleCardUpdate(agentId, agent) → 2s debounce
  ├── pushCardForAgent(agentId, agent) → send/update card to all bound chats
  └── AgentManager listeners: agent:update, agent:status, agent:input_required
```

Commands (uniform across all channels):
- `/list` — list all agents
- `/attach <name or id>` — bind chat to agent
- `/detach` — unbind
- `/stop` — stop bound agent
- `/status` — refresh card
- `/help` — show help

Model fields to add:
- `AgentConfig.slackChannelId?: string` — per-agent Slack notification target
- `AgentConfig.telegramChatId?: string` — per-agent Telegram notification target
- `AgentConfig.whatsappPhone?: string` — already exists (reuse for Baileys)
- `MetaAgentConfig.slackChannelId?: string`
- `MetaAgentConfig.telegramChatId?: string`

---

## Suggested Implementation Order

1. **Slack** — most impactful, best button support, Socket Mode is production-grade
2. **Telegram** — easiest to set up (just a bot token), buttons work great, huge user base
3. **WhatsApp** — most complex (Baileys session management, unofficial API risks), lower priority

---

## References

- OpenClaw architecture: https://docs.openclaw.ai/channels
- Slack Socket Mode: https://api.slack.com/apis/connections/socket
- Slack Block Kit: https://api.slack.com/block-kit
- grammY (Telegram): https://grammy.dev
- Baileys (WhatsApp): https://github.com/WhiskeySockets/Baileys
- Existing Feishu implementation: `server/src/services/FeishuService.ts`, `FeishuNotifier.ts`, `FeishuCardBuilder.ts`
