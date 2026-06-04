# Discuz Voice Agent Guide

Source: https://developers.openai.com/api/docs/guides/voice-agents

This project uses the official OpenAI Agents SDK realtime path for browser voice
discussion. The implementation target is a speech-to-speech live audio session
with `@openai/agents/realtime`, not a hand-written Realtime data channel loop.

## Official Recommendation

OpenAI's voice agents guide separates voice systems into two architectures:

| Architecture | Use when | Discuz choice |
| --- | --- | --- |
| Speech-to-speech live audio session | The experience should feel immediate, interruptible, and conversational. | Yes. Discuz is a live discussion surface. |
| Chained voice pipeline | The app needs explicit STT -> text agent -> TTS stages or deterministic approval gates. | No. Keep this only as a future alternative. |

For TypeScript browser voice agents, the official starting point is:

```ts
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

const agent = new RealtimeAgent({
  name: "Assistant",
  instructions: "You are a helpful voice assistant.",
});

const session = new RealtimeSession(agent, {
  model: "gpt-realtime",
});

await session.connect({
  apiKey: "ek_...(ephemeral key from your server)",
});
```

## Discuz Runtime Contract

Discuz follows the official browser flow:

1. The server creates an ephemeral client secret with the OpenAI SDK.
2. The frontend fetches that bootstrap payload from `/api/realtime/session`.
3. The frontend creates a `RealtimeAgent`.
4. The frontend creates an `OpenAIRealtimeWebRTC` transport so it can pass the
   selected microphone stream and audio element.
5. The frontend creates one `RealtimeSession` and connects with the ephemeral
   `ek_` client secret.
6. The session owns audio turns, interruption, function tool call output, and
   response sequencing.

## Server Responsibilities

The server must keep the real OpenAI API key private.

Current server responsibilities:

- Build the realtime session configuration in `buildRealtimeSessionConfig`.
- Include current Discuz instructions, voice settings, transcription settings,
  and tool schemas.
- Call `client.realtime.clientSecrets.create(...)`.
- Return only bootstrap data to the browser:
  - `clientSecret`
  - `expiresAt`
  - `model`
  - `instructions`
  - `tools`
  - `audio`
  - `settings`

The server must not proxy browser SDP manually for the main voice path.

## Frontend Responsibilities

The frontend owns user media selection and UI state. Realtime protocol details
belong to `RealtimeSession`.

Current frontend responsibilities:

- Request the selected microphone with `navigator.mediaDevices.getUserMedia`.
- Pass that stream into `OpenAIRealtimeWebRTC`.
- Build SDK tools from the server-provided JSON schemas using `tool(...)`.
- Delegate each tool execution to the local Discuz tool executor.
- Listen to session and transport events only to update UI state, subtitles,
  meeting records, and status bubbles.
- Use `session.sendMessage(...)` for text or system events.
- Use `session.interrupt()` for user interruption and cancellation.
- Use `session.close()` for disconnect cleanup.

## Structure Rules

Do not reintroduce these older paths:

- `RTCPeerConnection` setup owned by `App.tsx`
- `RTCDataChannel` or manual `oai-events` handling in app code
- Manual `response.function_call_arguments.done` handling
- Manual `function_call_output` event creation
- `/v1/realtime/calls` SDP proxying from the app server
- `/api/realtime/session` returning an SDP answer

Allowed low-level access:

- `OpenAIRealtimeWebRTC.changePeerConnection` may observe the SDK-created peer
  connection for output metering and connection-state UI only.
- `session.transport.requestResponse?.()` may be used as a small recovery hook
  when the UI needs to trigger a response after interruption or fallback.

## Web Tooling

`gpt-realtime` does not browse the web by itself. Discuz gives the realtime
agent explicit tools:

- `web_search`: discover candidate public web pages.
- `read_web_page`: extract readable title and text from a selected public URL.
- `open_web_page`: show a URL in the foreground web preview.

The default search chain is provider-based. Configure any of these environment
variables to use a dedicated search API before the no-key fallbacks:

- `BRAVE_SEARCH_API_KEY`
- `BING_SEARCH_API_KEY`
- `GOOGLE_SEARCH_API_KEY` plus `GOOGLE_SEARCH_ENGINE_ID`
- `SERPAPI_API_KEY`
- `TAVILY_API_KEY`

Optional controls:

- `WEB_SEARCH_PROVIDER` or `WEB_SEARCH_PROVIDERS`: comma-separated provider
  order, such as `brave,bing,duckduckgo,wikipedia`.
- `WEB_READ_USE_JINA=false`: disable the no-key Jina Reader fallback used when
  direct page extraction fails or returns too little text.

Known limits: login pages, paywalls, CAPTCHA, geofencing, anti-bot protection,
and heavily dynamic pages may still fail. The agent should say this clearly and
try another public source.

## Testing Checklist

Before considering the realtime migration valid:

- `npm run lint`
- `npm run build`
- `node --check server/index.js`
- POST `/api/realtime/session` and verify:
  - response status is `200`
  - `clientSecret` starts with `ek_`
  - `model` is the configured realtime model
  - `tools` is a non-empty array
  - response is JSON, not SDP
- Browser reload of `http://localhost:5173/` has no console errors.
- Final manual acceptance: with user permission, start the microphone session
  and confirm it reaches `Live`.

## Current Implementation Files

- `server/index.js`: builds the official realtime session config and creates
  the ephemeral client secret.
- `src/App.tsx`: creates `RealtimeAgent`, `OpenAIRealtimeWebRTC`, and
  `RealtimeSession`; maps SDK events into the Discuz UI.
- `package.json`: includes `@openai/agents` and `zod`.
