# Extra — The UX design agent

## What it adds

An optional design gate that runs **before planning**, triggered by a checkbox on
the task. When `ux_review_required` is set, pressing **Run** for the first time
starts a **`ux_design`** agent instead of planning. The agent opens a normal
conversation: the user chats with it to iterate on the design, and after each
turn the agent emits a complete, self-contained design document (textual
description + HTML mockup). When the user is satisfied, they click **Approve** —
the design is written into the task doc and the gate lifts. Only then can
planning (and the rest of the pipeline) start.

The payoff: implementation agents read a task doc that already contains a "UX
Design" section, so they know what the result is supposed to look like without
reading a conversation. The review agent uses the same section to verify that the
implementation matches the design, and if not, it bounces back to implementation
as usual.

## Why it's an extra (not core)

The core loop does not assume any visual or UX requirements exist. Projects
building CLI tools, data pipelines, or back-end services gain nothing from a
design pass. Adding this extra to a task that needs it is one checkbox; skipping
it leaves the pipeline unchanged.

## Where it inserts

The insertion point is the **manual Run gate** — the check that decides what to
start when the user presses Run from the Task Detail screen.

Core's logic today: if `planification_complete` is not set, start planning; else
the user is triggering an implementation run.

This extra adds a check **in front of** that, in the Run handler on the server
(`POST /api/tasks/:taskId/agent-runs` and the chaining logic):

- `ux_review_required = 1` and `ux_design_approved = 0` → **start `ux_design`**
  and return. Do not start planning yet.
- `ux_design_approved = 1` (or `ux_review_required = 0`) → fall through to the
  existing planning/chaining logic unchanged.

The `ux_design` agent is **not chainable** — it always stops and waits for a
human. The completion handler, when the finishing agent is `ux_design`, does
nothing: it marks the run `completed` and broadcasts the update, but does **not**
chain to planning. Planning starts only when the user presses Run after
approving.

## The state machine with this extra

```
[ux_review_required=1]
        ↓
  ux_design (conversation, iterates freely)
        ↓ user clicks "Approve"
  design written to task doc  +  ux_design_approved=1
        ↓ user presses Run
  planning ──(complete-plan → planification_complete)──▶ [STOP: human]
        ↓ user presses Run
  implementation ⇄ review  ──(review uses UX Design section)──▶ PR
```

## What the UX design agent does

The agent's system prompt
(`server/constants/prompts/ux-design.md`) instructs it to:

1. **Understand the request** — read the task doc's description section.
2. **Propose a complete design** — each turn must end with a full, standalone
   design document. The document has two parts:
   - A **Design Spec** in markdown: components, layout, interactions, state,
     accessibility notes, copy. Enough for an implementation agent reading only
     the task doc to know exactly what to build.
   - An **HTML Mockup**: a self-contained `<html>...</html>` block (inline CSS,
     no external dependencies) that visually represents the design. The frontend
     renders it in a sandboxed iframe alongside the message.
3. **Iterate on feedback** — the user can reply in the conversation. On each
   reply the agent refines the design and re-emits the full document. Nothing is
   partial; every turn is a complete, approvable design.

Hard constraints baked into the prompt: never touch the task doc, never run any
script, never start coding, never ask the user whether to proceed — just design
and iterate until the user approves.

### The mockup block format

The agent wraps its HTML in a fenced block with the language tag `html-mockup`:

````
```html-mockup
<!DOCTYPE html>
<html>…</html>
```
````

The frontend detects `html-mockup` blocks in the conversation renderer and
replaces the code block with a sandboxed iframe (`sandbox="allow-scripts"`).
Everything else in the turn renders as normal markdown.

### The Design Spec block format

The agent wraps its textual spec in a similarly tagged block:

````
```design-spec
## Design Spec

### Layout
…

### Components
…

### Interactions
…
```
````

The frontend renders this as a styled read-only panel (not a raw code block).
The **Approve** action extracts this block's content (not the HTML mockup) and
writes it to the task doc.

## The Approve action

A button labeled **"Approve this design"** is shown in the Task Detail screen
(or in the conversation header) whenever `ux_review_required = 1` and
`ux_design_approved = 0`. It is always enabled once at least one `ux_design`
agent run has completed.

Clicking it calls `POST /api/tasks/:taskId/approve-ux-design`. The handler:

1. Finds the latest completed `ux_design` agent run for the task, and its linked
   conversation.
2. Reads the last assistant message from that conversation.
3. Extracts the content of the `design-spec` block.
4. Appends (or replaces) a `## UX Design` section in the task doc at the
   archive path with that content.
5. Sets `ux_design_approved = 1` on the task row.
6. Broadcasts a `task-updated` WebSocket event so the UI re-renders.

The task doc's `## UX Design` section survives the rest of the pipeline
unchanged — it is written once and read by every subsequent agent.

## How implementation and review use the design

**Implementation** receives the full task doc, which now contains `## UX Design`.
Its prompt instructs it to treat that section as a constraint equal to the plan:
implement to spec, do not invent UI that wasn't described.

**Review** receives the same doc. Its verdict criteria expand to include a third
check alongside plan conformance and test results:

> Does the implementation match the UX Design section? If not, verdict is
> NEEDS_WORK. List the discrepancies under "Review Findings → UX Issues" in the
> task doc.

No extra orchestration is needed: the review–implementation loop already handles
NEEDS_WORK cycles. The implementation agent reads "UX Issues" in the next pass
and fixes them, exactly as it reads code-level review findings today.

## What to build

- [ ] Two boolean columns on the `tasks` row:
  - `ux_review_required INTEGER DEFAULT 0 NOT NULL`
  - `ux_design_approved INTEGER DEFAULT 0 NOT NULL`
- [ ] DB helpers: `setUxDesignApproved(taskId)`, `resetUxDesignApproved(taskId)`.
- [ ] A `ux_design` agent type in the enum and a `case 'ux_design'` branch in
      `startAgentRun` (no `disallowedTools` restriction — this is a chat agent).
- [ ] The UX design prompt (`server/constants/prompts/ux-design.md`): read task
      doc, propose complete Design Spec + HTML Mockup on every turn, iterate on
      feedback, never touch files or run scripts.
- [ ] `generateUxDesignMessage(taskDocPath, taskId)` in `agentPrompts.ts`.
- [ ] In the Run handler / chaining logic: if `ux_review_required = 1` and
      `ux_design_approved = 0`, start `ux_design` and return (do not chain to
      planning).
- [ ] In the completion handler: `ux_design` is **not** in the chainable set —
      mark `completed` and broadcast, nothing more.
- [ ] `POST /api/tasks/:taskId/approve-ux-design`: extract Design Spec from last
      conversation message, write `## UX Design` into the task doc, set
      `ux_design_approved = 1`, broadcast `task-updated`.
- [ ] Frontend: `html-mockup` block → sandboxed iframe in the conversation
      renderer; `design-spec` block → styled read-only panel.
- [ ] Frontend: "Approve this design" button in Task Detail, visible when
      `ux_review_required = 1 && !ux_design_approved`; disabled until one
      `ux_design` run has completed; calls the approve endpoint.
- [ ] Task creation / edit UI: a "Require UX design review" checkbox that sets
      `ux_review_required`.
- [ ] Review prompt update: add the UX Design conformance check and the "UX
      Issues" subsection under Review Findings.

## Reference map

| Concern | File |
|---|---|
| Gate insertion + non-chainable rule | `server/services/conversation/agentRunLifecycle.ts` |
| Run handler (manual start gate) | `server/routes/agent-runs.ts` |
| Approve endpoint | `server/routes/tasks.ts` (`POST /:taskId/approve-ux-design`) |
| UX design prompt | `server/constants/prompts/ux-design.md` |
| Message assembly | `server/constants/agentPrompts.ts` (`generateUxDesignMessage`) |
| Run start | `server/services/agentRunner.ts` (`case 'ux_design'`) |
| DB helpers | `server/database/db.ts` (`setUxDesignApproved`, `resetUxDesignApproved`) |
| Columns | `server/database/init.sql` (`ux_review_required`, `ux_design_approved`) |
| Mockup renderer | `src/components/ChatInterface.tsx` (or message renderer) |
| Approve button | `src/components/TaskDetailView.tsx` (or AgentSection) |
| Task creation checkbox | `src/components/` (new task form / task edit) |

## Boundaries (not in this spec)

- The state machine the gate lives inside (chaining, flags, the iteration cap,
  blocking) → [`../core/orchestration-loop.md`](../core/orchestration-loop.md).
- The planning agent that runs after approval →
  [`../core/planning-agent.md`](../core/planning-agent.md).
- The implementation–review loop that consumes the design →
  [`../core/execution-loop.md`](../core/execution-loop.md).
- The task doc format and archive path →
  [`../core/task-and-workspace.md`](../core/task-and-workspace.md).
- The conversation rendering (markdown, code blocks, message streaming) →
  [`./chat-ux.md`](./chat-ux.md).
