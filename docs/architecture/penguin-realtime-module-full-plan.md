# Penguin Realtime Module --- Full Plan

> 状态：Future / Not Implemented  
> 计划执行：未来版本，当前不进入实施  
> 说明：本文件是原始完整规划；实施前必须先完成 WebSocket/Socket.IO/SSE 技术 Spike，并按评审结论修订阶段与验收标准。


## Goal

Add one unified **Realtime** module to Penguin:

``` text
Penguin Client
├── REST
├── gRPC
├── gRPC-Web
└── Realtime
    ├── WebSocket
    ├── Socket.IO
    └── SSE
```

Do not create three top-level modules. The UI is unified, while
WebSocket, Socket.IO and SSE keep independent protocol implementations.

Future: MQTT, GraphQL Subscription and WebTransport.

## Core Principles

-   One Realtime module, multiple protocol engines.
-   Rust owns connection lifecycle; React owns presentation/UI state.
-   Lazy connect: opening Penguin or Realtime creates no connection.
-   Bounded memory, virtualized messages, batching and explicit cleanup.
-   Environment remains per-window.
-   Connections have clear window/tab ownership.
-   Socket.IO is **not** normal WebSocket.

``` text
React UI
   ↓
Tauri Commands / Channels
   ↓
RealtimeConnectionManager
   ├── WebSocket Client
   ├── Socket.IO Client
   └── SSE Client
```

## Capability Matrix

  Capability                  WebSocket     Socket.IO   SSE
  --------------------------- ------------- ----------- --------
  Connect / Disconnect        Yes           Yes         Yes
  Headers / Query Params      Yes           Yes         Yes
  Environment Variables       Yes           Yes         Yes
  Authentication              Yes           Yes         Yes
  Incoming                    Yes           Yes         Yes
  Outgoing                    Send          Emit        No
  Named Events                App-defined   Native      Native
  JSON/Text                   Yes           Yes         Yes
  Binary                      Yes           Yes         No
  Auto Reconnect              Yes           Yes         Yes
  Search / Filter / History   Yes           Yes         Yes

## Main UI

Keep Penguin's current three-column style:

``` text
┌──────────────┬──────────────────────────┬──────────────────────────┐
│ Collections  │ Connection / Composer    │ Messages / Events        │
│ Realtime     │ [ WebSocket ▼ ]          │ ● Connected              │
│  Auth WS     │ ws://{{HOST}}/ws         │ ← player.updated         │
│  Player WS   │ Params Headers Auth      │   {"id":1001}            │
│  Event SSE   │ Payload / Event          │ → subscribe              │
│  Chat IO     │               [ Send ]   │ ← update                 │
└──────────────┴──────────────────────────┴──────────────────────────┘
```

Protocol selector: `WebSocket | Socket.IO | SSE`.

## Common Connection State

``` text
Disconnected
Connecting
Connected
Reconnecting
Closing
Failed
```

Connected information can show duration, incoming/outgoing count, bytes
received/sent and last-message time.

## Environment & Variables

Reuse Penguin environments in URL, params, headers, auth and payloads.

``` text
QAT
WS_HOST=qat.example.com
TOKEN=abc123
PLAYER_ID=1000184
PLATFORM_ID=50
```

``` text
wss://{{WS_HOST}}/player/{{PLAYER_ID}}
Authorization: Bearer {{TOKEN}}
```

Unresolved variables must be shown before connect/send. Environment
selection remains independent per Penguin window.

## Shared Params / Headers / Auth

Reuse existing Penguin editors where practical.

Query params and headers support enable/disable, duplicate, delete and
environment variables.

Auth types:

``` text
None
Bearer Token
Basic Auth
API Key
Custom Headers
```

Socket.IO handshake `auth` remains separate from HTTP auth/headers.

# WebSocket

## Required Scope

-   `ws://` and `wss://`
-   Connect / Disconnect
-   Query params, headers and auth
-   Text / JSON / Binary
-   Incoming/outgoing timeline
-   Subprotocols (`Sec-WebSocket-Protocol`)
-   Reconnect and connection metrics
-   System/control frame visibility where observable

## Composer

``` text
Type: [ JSON ▼ ]

{
  "action": "subscribe",
  "playerId": "{{PLAYER_ID}}"
}

[ Send ]
```

JSON helpers: pretty, validate, minify and copy. Raw text must remain
sendable.

## Binary

Support file/binary send, received-frame size, bounded hex/UTF-8 preview
and large-payload protection. Never render huge binary payloads directly
in React.

# Socket.IO

## Required Scope

``` text
URL
Namespace
Path
Transport
Query
Headers
Auth
Timeout
Reconnect
```

Example:

``` text
URL: http://localhost:3000
Namespace: /chat
Path: /socket.io
Transport: WebSocket / Polling
```

## Event Composer

``` text
Event: message

{
  "roomId": "dev",
  "message": "hello"
}

[ Emit ]
```

Support named listeners and `Listen All Events` when available.

## ACK

Support acknowledgement callbacks:

``` text
Event: create-order
Payload: { "itemId": 123 }
Wait for ACK: Yes
Timeout: 5000 ms
```

Show ACK payload and latency; ACK timeout must be visible.

## Lifecycle

Expose connect, disconnect, connect_error, reconnect
attempts/success/failure and reason where available.

# SSE

## Required Scope

-   HTTP/HTTPS GET event stream
-   Headers, query params and auth
-   Connect / Disconnect
-   Preserve `event`, `data`, `id`, `retry`
-   Last-Event-ID
-   Reconnect

SSE has no normal Send/Emit composer.

``` text
Event: player.updated
ID: 10001829
Retry: 3000
Data: { "playerId": 1001 }
```

# Unified Message Experience

## Message Model

``` text
RealtimeMessage
├── id
├── connection_id
├── protocol
├── direction
├── kind
├── event_name
├── timestamp
├── payload
├── size
└── protocol_metadata
```

Directions: Incoming, Outgoing, System.

Kinds: Message, Event, ACK, Error, Connect, Disconnect, Reconnect, Ping,
Pong, Binary.

Do not discard protocol-specific metadata.

## Viewer & Detail

``` text
← Incoming
→ Outgoing
⚡ Event
✓ ACK
! Error
↻ Reconnect
● Connected
○ Disconnected
```

Message detail should show protocol, direction, exact timestamp, size,
event name, payload and metadata, with Pretty / Raw / Copy actions.

## Search & Filters

Search event name, payload, text, errors and system events.

Filters:

``` text
Direction: Incoming / Outgoing
Kind: Message / Event / ACK / System / Error
Event name
Contains text
```

Future: Regex, JSONPath, time range and size range.

## Pause / Follow / Clear

`Pause View` must not disconnect. Network reception continues into a
bounded buffer while UI following/rendering pauses.

When user scrolls upward, disable follow-latest and show
`↓ N new messages`.

`Clear Messages` clears the buffer/view but keeps the connection alive.

# Performance & Memory

## Bounded Buffer

Realtime streams are unbounded. Start with a benchmarked default around
**10,000 messages per active connection** using a bounded deque/ring
buffer. Drop oldest when full.

Do not keep duplicate full message arrays in multiple React states.

## Payload Limits

Design limits for max preview size, retained payload size and binary
preview. Large payloads show truncation and explicit load-more/full-view
behavior.

## Virtualization

10,000 buffered messages must not mean 10,000 DOM nodes. Render only
visible rows plus overscan.

## Batching & Backpressure

Do not trigger a React render for every high-throughput message.

``` text
Network
  ↓
Rust/channel buffer
  ↓
Batch
  ↓
Virtualized UI update
```

When input exceeds UI throughput: bounded queue, drop-oldest policy,
batch updates and deferred JSON formatting. Never allow unlimited queue
growth.

# Reconnect & Health

Common reconnect options:

``` text
Auto Reconnect
Initial Delay
Max Delay
Max Attempts
Strategy: Exponential Backoff
```

Example: `1s → 2s → 4s → 8s → 16s → 30s`.

Record connection loss/reconnect events in the timeline.

Track Last Message, Last Ping/Pong, latency and idle duration only where
genuinely observable.

# Collections & Persistence

Realtime requests should save like other Penguin requests. Collections
can eventually mix protocols:

``` text
FPMS
├── Authentication
│   ├── Get Login Config       REST
│   └── Auth Connection        WebSocket
├── Player
│   ├── Player Events          SSE
│   └── Player Socket          Socket.IO
```

Persist configuration, not runtime socket handles:

``` text
id / name / protocol
URL template
params / headers / auth
protocol-specific config
saved payload/event templates
reconnect settings
collection/folder
created_at / updated_at
```

Support Open, Open in New Window, Duplicate, Rename and Delete.

Plan versioned import/export. Do not accidentally export secrets in
plaintext.

# Tabs & Multi-Connection

``` text
[ Player WS ● ] [ Notification SSE ● ] [ Chat IO ● ] [+]
```

Each tab keeps request ID, protocol, connection ID, status, draft
payload, selected message, filters and scroll/follow state.

Use sensible limits/warnings to prevent accidental unlimited active
connections.

# Multi-Window Integration

``` text
Window #1 -> CP/QAT -> REST
Window #2 -> CP/QAT -> Realtime -> Player WS
Window #3 -> CP/UAT -> Realtime -> Player WS
Window #4 -> Terminal
```

Use Penguin's generic `openModuleInNewWindow(realtime, requestId)`
mechanism.

## Ownership V1

A Realtime connection belongs to the window/tab that created it.

Closing its tab/window must:

``` text
cancel reconnect timer
close socket/stream
stop reader task
release buffers
remove manager entry
```

Detachable/global connections can be considered later only if real usage
requires them.

# Rust Backend Architecture

``` text
Shared Rust Core
├── TerminalManager
├── RedisConnectionManager
├── MongoConnectionManager
└── RealtimeConnectionManager
    ├── WebSocket #1
    ├── WebSocket #2
    ├── Socket.IO #1
    └── SSE #1
```

Concept:

``` rust
enum RealtimeProtocol {
    WebSocket,
    SocketIo,
    Sse,
}
```

Avoid one giant config with dozens of `Option<T>` fields. Prefer:

``` text
CommonConnectionConfig
WebSocketConfig
SocketIoConfig
SseConfig
```

Runtime connection:

``` text
RealtimeConnection
├── connection_id
├── owner_window_id
├── owner_tab_id
├── protocol
├── status
├── started_at
├── counters
└── cancellation handle
```

## Tauri Communication

Use commands for control actions and streaming channels/events for
realtime data.

``` text
Connect / Send / Disconnect
          ↓
      Tauri command
          ↓
         Rust

Rust message stream
          ↓
    Channel / Event
          ↓
        React
```

Benchmark channel overhead under high message rates.

# Suggested File Structure

## Rust

``` text
src-tauri/src/realtime/
├── mod.rs
├── manager.rs
├── connection.rs
├── message.rs
├── error.rs
├── websocket/
│   ├── mod.rs
│   ├── client.rs
│   └── config.rs
├── socket_io/
│   ├── mod.rs
│   ├── client.rs
│   └── config.rs
└── sse/
    ├── mod.rs
    ├── client.rs
    └── config.rs
```

## React

``` text
src/modules/realtime/
├── RealtimePage.tsx
├── components/
│   ├── ConnectionBar.tsx
│   ├── ProtocolSelector.tsx
│   ├── ParamsEditor.tsx
│   ├── HeadersEditor.tsx
│   ├── AuthEditor.tsx
│   ├── MessageList.tsx
│   ├── MessageDetail.tsx
│   ├── MessageFilters.tsx
│   └── ConnectionStats.tsx
├── protocols/
│   ├── websocket/
│   ├── socket-io/
│   └── sse/
├── stores/
├── hooks/
└── types/
```

Extract Params/Header/Auth into shared Client components if REST/gRPC
can genuinely reuse them.

# Error Handling

Developer-friendly categories:

``` text
Invalid URL
DNS failure
Connection refused
TLS/certificate error
Handshake rejected
Authentication error
Protocol error
Timeout
Unexpected disconnect
Payload error
Socket.IO connect_error
SSE HTTP error
```

Show timestamp, protocol, resolved target, summary and expandable
technical detail.

Never silently retry authentication/configuration errors forever.

# TLS & Security

Support secure schemes by default (`wss://`, `https://`).

Developer-only TLS options such as custom CA or disabling verification
must be explicit and visibly marked unsafe.

Mask secrets in normal UI/logs and avoid leaking them into exports.

# History

Separate saved request configuration from runtime message history.

V1 can keep message history session-only. Later persistence should be
bounded and opt-in.

Connection-history metadata can include request, protocol, environment,
connected/disconnected timestamps, duration, message counts, bytes and
final error/status.

# Keyboard Shortcuts

Potential shortcuts:

``` text
Cmd/Ctrl + Enter       Send / Emit
Cmd/Ctrl + K           Clear messages
Cmd/Ctrl + F           Search messages
Cmd + Shift + N        New Penguin window
```

Avoid conflicts with standard macOS behavior.

# Testing Plan

## Functional

### WebSocket

-   ws/wss connect
-   Headers/query/auth
-   Text/JSON/binary
-   Subprotocol
-   Server close
-   Reconnect
-   Invalid URL, refusal and TLS failure

### Socket.IO

-   Connect
-   Namespace/custom path
-   Headers/query/auth
-   Emit/listen
-   ACK success/timeout
-   Disconnect reason
-   Reconnect/connect_error
-   Transport behavior

### SSE

-   Connect
-   Headers/query/auth
-   event/data/id/retry
-   Last-Event-ID
-   Server close/reconnect
-   HTTP errors

## Performance

Benchmark:

``` text
1 active connection
5 active connections
10 active connections

10 msg/s
100 msg/s
1,000 msg/s
burst traffic
large payloads
```

Measure RAM, Rust CPU, WebView CPU, UI responsiveness/FPS, message
latency, buffer growth and cleanup after disconnect.

## Long Running

Run 4h, 8h and full-workday tests. Memory should remain bounded rather
than continuously grow.

Repeatedly connect/disconnect and create/destroy tabs/windows to detect
leaks and orphan tasks.

# Development Roadmap

## Phase 1 --- Foundation

-   Realtime route/module
-   Protocol selector
-   Shared request/message models
-   RealtimeConnectionManager
-   Connection state/events
-   Bounded buffer

Acceptance: opening Realtime creates zero network connections.

## Phase 2 --- WebSocket MVP

-   ws/wss
-   Connect/disconnect
-   Headers/query/auth
-   Text/JSON
-   Timeline/errors
-   Cleanup

## Phase 3 --- WebSocket Advanced

-   Binary
-   Subprotocols
-   Reconnect
-   Metrics
-   Search/filter
-   Virtualization/batching

## Phase 4 --- SSE

-   Stream connection
-   Headers/query/auth
-   event/data/id/retry
-   Last-Event-ID
-   Reconnect

## Phase 5 --- Socket.IO

-   Real Socket.IO client
-   Namespace/path/transports
-   Auth
-   Emit/listen
-   ACK
-   Reconnect/lifecycle events

## Phase 6 --- Collections

-   Save/load
-   Duplicate/rename/delete
-   Mixed-protocol collections
-   Event/payload templates
-   Versioned import/export

## Phase 7 --- Multi-Window

-   Open in new window
-   Per-window environment
-   Ownership/cleanup
-   Multiple simultaneous Realtime windows

## Phase 8 --- Performance Hardening

-   Message batching
-   Backpressure
-   Virtualization
-   Large payload handling
-   4h/8h/full-day benchmark
-   Leak/orphan-task tests

## Phase 9 --- Optional Advanced Features

-   Connection timeline
-   Regex/JSONPath filters
-   Export selected messages
-   Request scripting/hooks
-   MQTT
-   GraphQL Subscription
-   WebTransport

# Definition of Done

This workflow must work reliably:

``` text
Launch Penguin

Window #1
  -> CP / QAT
  -> REST
  -> call login API

Window #2
  -> CP / QAT
  -> Realtime
  -> WebSocket
  -> connect
  -> send subscription
  -> inspect live messages

Window #3
  -> CP / UAT
  -> Realtime
  -> SSE
  -> inspect server events

Window #4
  -> Terminal
  -> run backend logs
```

Closing Window #2 must clean only its owned Realtime connections and
must not affect Window #1/#3/#4.

No Realtime connection starts merely because Penguin or a new window
exists.

Long-running realtime sessions must have bounded memory.

# Final Architecture

``` text
                           Penguin
                     One Tauri Application
                              |
          +-------------------+-------------------+
          |                   |                   |
      Window #1           Window #2           Window #3
        REST               Realtime             SSE
                              |
                              v
                    Realtime React Module
                              |
                       Tauri Channel/API
                              |
                              v
                    Shared Rust Core
                              |
                 RealtimeConnectionManager
                    /         |          \
                   /          |           \
            WebSocket      Socket.IO       SSE
```

## Guiding Rules

> **One Realtime module, three real protocol implementations.**

> **Lazy connect, bounded memory, virtualized UI and explicit cleanup.**

> **Share request UX, not protocol internals.**

> **Realtime must work naturally with Penguin Collections, Environments,
> Tabs and Multi-Window.**
