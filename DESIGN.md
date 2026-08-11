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

- Default window: `1360 × 860 pt`; minimum: `640 × 620 pt`.
- Left sidebar: fixed `286 pt` in the current workbench. It is inline at `≥880 pt`, an overlay below that boundary, open by default, and completely removed from hit-testing and accessibility when hidden.
- Work Inspector: fixed `340 pt` inline at `≥1280 pt`; at smaller widths it is an explicit trailing overlay. Automatic width hiding and user-requested hiding remain separate states.
- Conversation content: centered, maximum `820 pt`, with `28 pt` horizontal and `24 pt` vertical breathing room.
- Session header and composer stay outside the scrolling transcript, separated by native hairlines.
- Long paths truncate in the middle and expose the full value through help text or selection.

## Reference boundary

> Target Reference（目标参考）：响应式工作台和 Project Files/Changes 已进入 `0.0.1`；Agent Team、中央文件标签与预览仍是后续目标，不表示已经实现。

The maintained reference index is [`doc/参考文件/README.md`](doc/参考文件/README.md). Codex provides the primary workbench structure, ZCode informs information hierarchy, MiniMax Code informs Agent Team presentation, and Orca informs tabs and previews. D Code translates those patterns into native macOS controls rather than copying visual skins or adopting another product's runtime. The left sidebar is open by default; the right inspector appears when width is sufficient and otherwise becomes an explicit overlay without reducing the conversation below its comfortable width.

## Type and spacing

- Session and message body: system body.
- Primary labels: semibold body/headline, never oversized.
- Secondary metadata: caption; timestamps and counts use monospaced digits.
- Reusable radii: `8 pt` compact, `10 pt` controls and tool surfaces, `14 pt` user messages.
- Transcript rhythm: `18 pt` between semantic messages, `4–10 pt` within one message or tool unit.

## Components

### Session sidebar

The sidebar starts with the latest ten sessions created by D Code and loads ten more on demand without opening transcript content. It does not expose every Pi session under the macOS home directory. D Code Project is the navigation object; after a Source Folder is associated, all Pi Sessions whose normalized `cwd` exactly matches that folder appear as one cross-folder recency list rather than folder groups. Each project session shows its Source Folder as secondary text. The same D Code-created session may appear in Recent and its Project with one stable ID. The Project row selects project Files/Changes; its separate chevron expands sessions, and its plus menu creates a Session in one registered Source Folder. Selecting a Session alone opens its history and offers direct continuation. Connection and reload state stay in the quiet footer.

### Search overlay

The sidebar search action and global `Command-K` open one centered native overlay without replacing the workbench. The search field owns initial focus; Project and Source Folder filters remain compact but keep `40 pt` targets. Empty input shows the latest visible sessions. Results combine title, best snippet, role, match count, time, Project/Source Folder ownership, and full-path help while remaining one selectable row per stable Session ID. The covered workbench and toolbar leave hit-testing and the accessibility tree until the overlay closes. Index build, rebuild, query failure, no-result, and target-open failure are distinct states; an open failure preserves the result list so another row can be chosen. `Escape` restores the prior responder, and a successful Entry ID result scrolls to and briefly highlights the same persisted message.

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

A fixed native text editor supports multiline input, `Command-Return` send, Return newline, explicit stop while streaming, slash-command suggestions, and Session runtime controls. Model, thinking, Fast, and context usage remain in the Composer; raw extension status or Pi footer concepts never become permanent product chrome. Existing Pi sessions keep the same editor while D Code observes external persisted updates. Sending or changing runtime controls acquires write ownership on demand; failure preserves the exact draft and reports the real conflict without replacing the composer with a generic read-only state. A sent draft is cleared when the source-bounded, call-local RPC user record has joined the verified Pi session snapshot; nested extension prompts run behind a separate source boundary and cannot confirm the outer RPC input. An extension-handled command with no RPC user record clears only when that exact Host prompt call completes. Neither path borrows an unrelated user-message event.

### Structured UI boundary

Standard `select`, `confirm`, `input`, and `editor` requests become native sheets. D Code does not render `pi-tui`, terminal frames, arbitrary extension widgets, headers, footers, custom editor components or other custom components. Calls that require an unavailable user interaction fail explicitly; presentation-only hints may be ignored diagnostically without interrupting the user. Tool-expansion queries follow Pi RPC's neutral collapsed/no-op behavior rather than masquerading as a product failure. New product capabilities receive D Code-owned structured contracts and native components.

## State and feedback

- Streaming, actual write conflict, loading, and Host failure are visually distinct and exposed to accessibility; the internal observation implementation is not presented as a user-facing read-only mode.
- Use green only for verified ready/writable/completed state, orange for active work or explicit limitations, and red for errors or destructive stop.
- Empty, loading, and failure states name the next available action.
- Notifications are transient material banners; blocked extension interactions and other blocking failures use native alerts, while ignored presentation hints remain diagnostic only.

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
- `app/Sources/PiDCode/Views/SearchOverlayView.swift`
- `app/Sources/PiDCode/Views/ConversationView.swift`
- `app/Sources/PiDCode/Views/ActivePlanView.swift`
- `app/Sources/PiDCode/Views/ComposerView.swift`
- `app/Sources/PiDCode/Views/ExtensionViews.swift`
- `app/Sources/PiDCode/Views/ContentBlockViews.swift`

Update unlabelled component rules only when a verified component changes the shared visual or interaction contract. Confirmed future rules must stay inside an explicit Target Reference section.
