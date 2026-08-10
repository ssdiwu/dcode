# D Code Design System

> Status: current native component rules plus explicitly labelled Target Reference（目标参考）. `PRODUCT.md` defines product intent; unlabelled component rules in this file describe the running SwiftUI slice.

## Character

Calm, precise, capable. The interface should feel like a focused macOS workbench rather than a browser dashboard: one primary conversation, a restrained session sidebar, honest runtime state, and progressive disclosure for technical depth.

## Foundations

- Use semantic macOS colors (`windowBackgroundColor`, `textBackgroundColor`, `controlBackgroundColor`, `primary`, `secondary`, `accentColor`) rather than fixed light/dark palettes.
- Use system typography. Technical paths, IDs, JSON, timestamps, code, and diagnostic payloads use monospaced variants; counts use tabular digits.
- Avoid decorative gradients, glass stacks, large marketing type, and repeated card grids.
- Current density is deliberate: compact enough for engineering history, with at least `40 × 40 pt` interactive targets.

## Layout

- Default window: `1240 × 820 pt`; minimum: `900 × 620 pt`.
- Sidebar: `230–380 pt`, ideal `285 pt`; native `NavigationSplitView` and sidebar list behavior.
- Conversation content: centered, maximum `820 pt`, with `28 pt` horizontal and `24 pt` vertical breathing room.
- Session header and composer stay outside the scrolling transcript, separated by native hairlines.
- Long paths truncate in the middle and expose the full value through help text or selection.

## Reference boundary

> Target Reference（目标参考）：本节描述已确认的工作台方向，不表示右侧检查器、Agent Team 或预览已经由当前 Swift App 实现。

The maintained reference index is [`doc/参考文件/README.md`](doc/参考文件/README.md). Codex provides the primary workbench structure, ZCode informs information hierarchy, MiniMax Code informs Agent Team presentation, and Orca informs tabs and previews. D Code translates those patterns into native macOS controls rather than copying visual skins or adopting another product's runtime. The left sidebar is open by default; the right inspector appears when width is sufficient and otherwise becomes an explicit overlay without reducing the conversation below its comfortable width.

## Type and spacing

- Session and message body: system body.
- Primary labels: semibold body/headline, never oversized.
- Secondary metadata: caption; timestamps and counts use monospaced digits.
- Reusable radii: `8 pt` compact, `10 pt` controls and tool surfaces, `14 pt` user messages.
- Transcript rhythm: `18 pt` between semantic messages, `4–10 pt` within one message or tool unit.

## Components

### Session sidebar

Sessions are grouped first by exact `cwd`, with a visible folder header, full path, and group count; session rows then show title, message count, and relative modification time without repeating the project name. Search matches title, cwd, and stable Session ID. “New session” is an explicit labelled action beside the workspace heading; manual reload is a labelled footer action instead of an unexplained window-toolbar icon. Selecting an existing row opens its history and offers direct continuation. Connection state and loaded count remain in the quiet footer.

### Conversation

- User text uses a content-sized accent-tinted bubble aligned to the trailing edge; short prompts never expand into full-width cards.
- Assistant content remains uncontained on the reading canvas; its copy action appears on hover or keyboard focus.
- Thinking is collapsed by default in a `DisclosureGroup`.
- Tool calls and results are compact disclosure surfaces with explicit running/completed/error state.
- A persisted assistant message replaces its streaming presentation at `message_end`; message boundaries clear transient text without hiding an active tool run.
- Provider errors show a concise failure summary first and preserve raw technical detail in an expandable disclosure.

### Native content blocks

Fenced code uses a quiet native surface with language label, horizontal scrolling, selectable monospaced text, and a copy action. Mermaid fences render as selectable Unicode diagrams with semantic system colors, bounded two-axis scrolling, `60–200%` zoom, source/image copy, and PNG export. The header always names the detected diagram kind. Advisory warnings remain visible; unsupported or failed diagrams must show an explicit error and the original source instead of a blank or false success. PNG export uses a deterministic light canvas at `2×` scale.

### Active Plan

An active Goal/Plan is a D Code-owned component anchored between transcript and composer. The current implementation can project recognized dgoal state into it, but the component contract is not owned by the extension. The collapsed state shows objective, current step, progress bar, and tabular count; expansion reveals phase and item status in a bounded scroll area. Completed or abandoned goals disappear entirely rather than becoming permanent chrome.

### Composer

A fixed native text editor supports multiline input, `Command-Return` send, Return newline, explicit stop while streaming, slash-command suggestions, pending queue count, and progressive capability status in a menu instead of an overflowing raw footer. Read-only sessions replace the editor with a direct “continue session” action; its confirmation explains exclusive use and conflict detection without exposing plugins, marker records, or protocol identifiers.

### Structured UI boundary

Standard `select`, `confirm`, `input`, and `editor` requests become native sheets. D Code does not render `pi-tui`, terminal frames, arbitrary extension widgets, headers, footers, custom editor components or other custom components. Those calls emit an explicit unsupported event and are blocked or ignored according to whether the caller is waiting for a result. New product capabilities receive D Code-owned structured contracts and native components.

## State and feedback

- Writable, read-only, streaming, conflict, loading, and Host failure are visually distinct and exposed to accessibility.
- Use green only for verified ready/writable/completed state, orange for active work or explicit limitations, and red for errors or destructive stop.
- Empty, loading, and failure states name the next available action.
- Notifications are transient material banners; blocking failures use native alerts with the original safe error code/message.

## Motion and accessibility

- Motion is limited to short state transitions, press feedback, banners, and transcript auto-scroll.
- Respect Reduce Motion by removing animated transcript scrolling; semantic state must never depend on motion.
- Semantic system colors support Dark Mode, Increase Contrast, and Reduce Transparency fallbacks.
- Preserve native keyboard focus, full keyboard navigation, selectable technical values, and combined VoiceOver labels for session rows and state controls.
- Do not put essential actions below `40 × 40 pt` or communicate error/success by color alone.

## Source of truth

Concrete tokens and components live in:

- `app/Sources/PiDCode/Views/DesignSystem.swift`
- `app/Sources/PiDCode/Views/RootView.swift`
- `app/Sources/PiDCode/Views/ConversationView.swift`
- `app/Sources/PiDCode/Views/ActivePlanView.swift`
- `app/Sources/PiDCode/Views/ComposerView.swift`
- `app/Sources/PiDCode/Views/ExtensionViews.swift`
- `app/Sources/PiDCode/Views/ContentBlockViews.swift`

Update unlabelled component rules only when a verified component changes the shared visual or interaction contract. Confirmed future rules must stay inside an explicit Target Reference section.
