# Extra — Multi-repo epics (umbrella projects)

## What it adds

A way to drive one piece of work that spans **several repositories** without
changing the core rule *one task = one worktree = one branch = one PR*.

> My product is split across an `api` repo and a `front` repo. I create an
> **umbrella project** and attach both repos to it as **child projects**. On the
> umbrella's board I create an **epic** — "Let users export their invoices as
> PDF" — and press **Run**. A **breakdown agent** reads the code of *every* child
> repo, asks me the questions that matter, and proposes a breakdown: a shared
> contract (the endpoint, the payload, the events) and several sub-tasks per
> repo, with the dependencies between them. I review it and press **Approve**.
> Bottega creates the sub-tasks as ordinary tasks in each child project — each
> with its own worktree, its own doc, its own pipeline, its own PR. From the
> epic page I see every sub-task across every repo, its status, and what it is
> waiting on; one click takes me to the sub-task in its child project.

The umbrella never writes code. It owns the cross-repo *thinking* (the breakdown
and the contract); the child projects own the code.

## Why it's an extra (not core)

Core is one repo per task, by design. Most teams work in a single repo (or a
monorepo, which core already handles via `subproject_path`). Multi-repo
coordination is a preference, and it is built entirely **on top of** core: the
sub-tasks it creates are plain core tasks that run the unchanged
`planning → (implementation ⇄ review) → PR` loop. Skip this extra and nothing
else notices.

### Why not "one project with N repos"

The tempting alternative — let a project point at several repos — breaks every
core invariant at once: `repo_folder_path` is a single path, a task has one
worktree and one `cwd`, the review agent runs one test suite, the PR agent
watches one CI and resolves conflicts in one repo. Making all of those plural
means N worktrees, N PRs to keep in sync, and partial merges. Decomposing into
per-repo tasks keeps each PR small, reviewable, and independently green.

## Vocabulary

- **Umbrella project** — a project flagged `is_umbrella = 1`. It has no code of
  its own; its `repo_folder_path` is a *workspace folder* (typically the
  directory that contains the child repos) used only as the breakdown agent's
  `cwd`. It need not be a git repo.
- **Child project** — an ordinary project whose `parent_project_id` points at an
  umbrella. One level only: an umbrella has no parent, a child is never an
  umbrella.
- **Epic** — a task that lives in an umbrella project. It is never isolated in a
  worktree (`uses_worktree = 0`) and never runs the implementation pipeline.
- **Breakdown agent** (`breakdown`) — the epic's only agent: the umbrella's
  equivalent of the planning agent.
- **Sub-task** — an ordinary task in a child project whose `parent_task_id`
  points at an epic.
- **Dependency** — "sub-task B may not start implementation until sub-task A's
  PR is ready". Stored as an edge between two sub-tasks of the same epic.

## Data model

All additive; nothing in core changes shape.

| Change | Purpose |
|---|---|
| `projects.is_umbrella INTEGER NOT NULL DEFAULT 0` | Marks an umbrella. |
| `projects.parent_project_id INTEGER NULL → projects(id) ON DELETE SET NULL` | Links a child to its umbrella. Deleting the umbrella orphans the children; it never deletes them. |
| `tasks.parent_task_id INTEGER NULL → tasks(id) ON DELETE SET NULL` | Links a sub-task to its epic. Deleting an epic never deletes code-bearing sub-tasks. |
| `tasks.breakdown_approved INTEGER NOT NULL DEFAULT 0` | The epic's human gate: set once the breakdown was approved and the sub-tasks created. |
| `tasks.waiting_on_dependencies INTEGER NOT NULL DEFAULT 0` | The sub-task asked to start implementation while a dependency was not ready; the scheduler starts it later. |
| `task_dependencies(task_id, depends_on_task_id)` (PK on both, both `ON DELETE CASCADE`) | The dependency edges. |
| `task_agent_runs.agent_type` gains `'breakdown'` | The new agent. |

The breakdown itself lives **in the archive next to the epic doc**, as a JSON
file: `~/.bottega/projects/{umbrellaId}/tasks/task-{epicId}.breakdown.json`.
Same reason as the doc (see [`task-and-workspace.md`](../core/task-and-workspace.md)):
it must survive everything else.

Invariants enforced at the HTTP boundary:

- an umbrella cannot have a parent, and cannot be attached as a child;
- `is_umbrella` is chosen at creation and never changes afterwards;
- the breakdown can only target the epic's umbrella's **current** children;
- dependency edges only join sub-tasks of the same epic, and never form a cycle.

## The flow

```
[umbrella project]                                  [child projects]

epic (doc = the request)
   │ Run
   ▼
breakdown agent ── reads every child repo (read-only)
   │  writes: epic doc (overview + shared contract + breakdown, human-readable)
   │          task-{epicId}.breakdown.json (machine-readable)
   │  runs:   complete-breakdown.ts  → validates JSON → planification_complete
   ▼
[STOP: human reviews the proposed breakdown on the epic page]
   │ Approve (optionally "start planning on every sub-task")
   ▼
create sub-tasks ───────────────────────────────▶ task in api   (worktree, doc)
   breakdown_approved = 1                         task in api   (worktree, doc)
   epic status → in_progress                      task in front (worktree, doc, depends on api#1)
                                                        │
                                       each runs the unchanged core loop
                                                        │
                    api#1 PR agent completes ──────────▶ scheduler starts front#3's
                                                         implementation if it was waiting
   all sub-tasks completed ──▶ epic status → completed
```

### 1. The breakdown agent

Started by pressing **Run** on an epic (`POST /api/tasks/:epicId/agent-runs`
with `agentType: 'breakdown'`; the UI shows only that agent for epics, and the
server rejects pipeline agents on an epic with 400).

It runs with:

- `cwd` = the umbrella's workspace folder;
- the **absolute path of every child repo** in its prompt, plus each child's
  name, project id, project type and README path (agents run with
  `bypassPermissions`, so they read outside their `cwd` by absolute path);
- the epic doc path, the breakdown JSON path, and the completion script path.

Its prompt ([`breakdown.md`](../reference/server/constants/prompts/breakdown.md))
makes it **read-only on the child repos**: explore with read-only research
sub-agents, never edit, never run anything but the completion script. Its
workflow mirrors [`planning-agent.md`](../core/planning-agent.md):

1. **Explore every child repo** relevant to the request — existing endpoints,
   models, client calls, conventions — so the contract matches what is there.
2. **Clarify** only genuine cross-repo trade-offs (e.g. "new endpoint or extend
   the existing one?").
3. **Write the epic doc**: `## Original Request` (verbatim), `## Overview`,
   `## Shared Contract` (the single source of truth every sub-task will
   receive), `## Breakdown` (sub-tasks grouped by project, with dependencies).
4. **Write the breakdown JSON** (below).
5. **Run `complete-breakdown.ts <epicId>`.** The script validates the JSON with
   the same schema the server uses; on failure it prints every issue and exits
   non-zero so the agent fixes the file and retries. On success it sets
   `planification_complete` — the flag the loop already understands as "plan
   ready, stop for a human".

Like planning, the breakdown agent is a **human gate**: nothing chains after
it. The user can keep chatting with it in the same conversation to reshape the
breakdown; each turn re-writes both files and re-runs the script.

The human can also **edit the breakdown directly** before approving it
(`PUT /api/tasks/:epicId/breakdown`): summary, shared contract, and each
sub-task's title, target repo, description and dependencies, plus adding or
removing sub-tasks. The server applies the exact validation of
`complete-breakdown.ts`, rewrites the JSON, and sets `planification_complete`
(a valid human-saved breakdown is ready for approval). Edits are refused once
the breakdown is approved or while the breakdown agent is running. They change
the JSON — what sub-tasks are created from — not the epic doc's prose.

#### Sizing rule baked into the prompt

Each sub-task must be a normal Bottega task: one repo, one PR, implementable
and testable end-to-end by the agents of that repo **on its own**, given the
shared contract. Several sub-tasks per repo are expected when the work has
natural seams (e.g. "migration + model", then "endpoint"). A dependency is
declared only when the dependent truly cannot be implemented and tested
without the other's code — working against the contract is the default.

### 2. The breakdown JSON — the contract between the agent and the server

```json
{
  "summary": "One paragraph: what the epic delivers.",
  "sharedContract": "Markdown. Endpoints, payloads, events, env vars shared across repos.",
  "subtasks": [
    {
      "key": "api-export-endpoint",
      "projectId": 12,
      "title": "Add GET /invoices/:id/pdf",
      "description": "Markdown. What to build in this repo, acceptance criteria.",
      "dependsOn": []
    },
    {
      "key": "front-export-button",
      "projectId": 13,
      "title": "Add 'Export PDF' button on invoice page",
      "description": "…",
      "dependsOn": ["api-export-endpoint"]
    }
  ]
}
```

Validation (shared zod schema + semantic checks,
`shared/schemas/epics.ts` + `server/services/epicService.ts`):

- 1–30 sub-tasks; `key` unique, `[a-z0-9-]`; `title` non-empty;
- every `projectId` is a current child of the epic's umbrella;
- every `dependsOn` entry names another key; no self-dependency; no cycle.

The server never parses the agent's prose. Like core's signalling scripts,
**the file plus a flag is the whole interface.**

### 3. Approval — creating the sub-tasks

`POST /api/tasks/:epicId/breakdown/approve` with `{ startPlanning?: boolean }`.

Preconditions: the epic is in an umbrella, `planification_complete = 1`,
`breakdown_approved = 0`, no agent running on the epic, and the JSON validates.

Then, in **topological order** (so a dependent knows its dependencies' branch
names):

1. Create the task in its child project exactly like core's task-create
   (`uses_worktree` decided once from "is the repo a git repo", worktree created,
   row rolled back on failure), with `parent_task_id = epicId`.
2. Seed its doc with: the title, a pointer to the epic (title, id, and the epic
   doc's absolute path — "read it for the cross-repo picture"), the sub-task
   description, the **shared contract** verbatim, and its dependencies (task id,
   title, project, branch). That doc is the sub-task's original request: the
   child's planning agent quotes it verbatim, so the contract flows into the
   plan and on to implementation and review untouched.
3. Insert its dependency edges.

If any creation fails, everything created so far in this approval is torn down
(worktrees removed, rows and archives deleted) and the endpoint returns 500 —
an epic is either fully broken down or not at all.

Finally set `breakdown_approved = 1`, move the epic to `in_progress`, and, when
`startPlanning` is set, start the **planning** agent on every sub-task. Planning
is never gated by dependencies — it plans against the contract.

### 4. Dependency gating and the scheduler

A dependency is **satisfied** when the dependency task has `pr_agent_complete = 1`
(its PR is open and CI green) or `status = 'completed'`. The dependent can then
branch off or pull the dependency's branch if it needs the code; its doc names
that branch.

Gating applies only to the entry points of *code* work — `implementation` and
`yolo`:

- **Manual Run** (`POST /tasks/:id/agent-runs`) with unmet dependencies does not
  start anything: it sets `waiting_on_dependencies = 1`, broadcasts a
  `task-updated` event (a task-scoped WebSocket message carrying the fresh task
  row, which `TaskContext` merges into its state), and answers
  **202** `{ waiting: true, waitingOn: [...] }`.
- **Batch start** of pending tasks treats a waiting YOLO task the same way and
  reports it as skipped.
- **Auto-chain after planning** (the non-technical role extra) does the same
  instead of chaining.

The **scheduler** is a single function, `releaseDependents(taskId)`, called
whenever a task can have just satisfied someone else:

- in the completion handler, after a `pr` or `yolo` run, when
  `pr_agent_complete` is set;
- in `PUT /tasks/:id` when a task's status becomes `completed`.

For every dependent with `waiting_on_dependencies = 1` whose dependencies are
now *all* satisfied and that has no running agent, it clears the flag and starts
`yolo` (YOLO tasks) or `implementation` through the normal `startAgentRun`, as
the dependent's owner. Clearing `waiting_on_dependencies` by hand
(`PUT /tasks/:id`) cancels the wait.

### 5. Epic status

The epic's `status` is derived from its sub-tasks, recomputed by
`syncEpicStatus(epicId)` whenever a sub-task's status changes through the paths
above: `completed` when every sub-task is completed, `in_progress` otherwise
once approved. The human can still override it from the UI.

## The UI

### Dashboard

Umbrella cards carry a **Multi-repo** badge and one chip per child project;
clicking a chip opens that child's board. Child cards show a small
`↳ <umbrella>` link. Everything else is unchanged.

### Creating and wiring umbrellas

- The project-create modal gets an **Umbrella project (multi-repo)** checkbox;
  the folder becomes a "workspace folder".
- On the umbrella's board, **Child projects** opens a modal listing every
  project the user can see that is neither an umbrella nor attached to another
  umbrella; ticking boxes calls `PUT /api/projects/:id/children` with the full
  list of child ids.

### The umbrella board

The same Kanban, but its cards are epics (**New Epic** instead of New Task; the
PO session and web-server controls are hidden). Above the columns, a
**children strip** shows one chip per child project with its task counts —
click to open the child's board. This is the "from the parent, click through to
the child" view.

### The epic page

The task detail page of an epic swaps the pipeline for:

- the **Breakdown** agent row (Run / Running / Completed, conversation link);
- an **Epic panel**, fed by `GET /api/tasks/:epicId/epic`:
  - **before approval** — the proposed breakdown grouped by child project
    (title, a plain-text excerpt that expands to the full markdown description,
    dependencies), the shared contract rendered as markdown, validation errors
    if the file is invalid, an **Edit** mode, a **Run Breakdown** button, and
    **Approve & create sub-tasks** with a "start planning on every sub-task"
    checkbox;
  - **after approval** — every sub-task grouped by child project: status pill,
    live indicator, "waiting on #12" badge, dependency list. Clicking a sub-task
    opens it **in its child project** (`/projects/:childId/tasks/:taskId`);
    clicking a group header opens the child's board. The panel subscribes to the
    sub-tasks' WebSocket channels and refetches on their events.

### Sub-task pages and cards

- A sub-task's detail page shows an **epic banner** — link back to the epic in
  the umbrella — plus its dependencies (satisfied or not) and, when waiting, a
  "will start automatically once #12's PR is ready" notice with a **Cancel
  wait** action. Fed by `GET /api/tasks/:id/epic-context`.
- Board cards of sub-tasks carry an `Epic #N` badge and, when waiting, an
  hourglass badge.

## HTTP surface

| Endpoint | Does |
|---|---|
| `POST /api/projects` | Accepts `isUmbrella`. |
| `PUT /api/projects/:id/children` | `{ childIds }` — replaces the umbrella's children. |
| `GET /api/tasks/:epicId/epic` | Epic + parsed breakdown (or validation error) + sub-tasks with project, dependencies and satisfaction. |
| `PUT /api/tasks/:epicId/breakdown` | Human edit of the proposed breakdown (same validation as the script). |
| `POST /api/tasks/:epicId/breakdown/approve` | `{ startPlanning? }` — creates the sub-tasks. |
| `GET /api/tasks/:id/epic-context` | The parent epic (if any), dependencies and dependents of a sub-task. |
| `POST /api/tasks/:id/agent-runs` | Rejects pipeline agents on an epic (400), rejects `breakdown` outside an epic (400), answers 202 `waiting` on unmet dependencies. |
| `PUT /api/tasks/:id` | Accepts `waiting_on_dependencies: false` (cancel wait); completing a task releases its dependents and syncs its epic. |

## What to build

- [ ] Migrations: `projects.is_umbrella`, `projects.parent_project_id`,
      `tasks.parent_task_id`, `tasks.breakdown_approved`,
      `tasks.waiting_on_dependencies`, `task_dependencies`, `'breakdown'` agent type.
- [ ] Umbrella/children wiring endpoints with the one-level invariants.
- [ ] The `breakdown` agent: prompt, prompt assembly (children list), model
      settings entry, epic-only guard.
- [ ] The breakdown JSON schema + semantic validation shared by the script and
      the server; `complete-breakdown.ts`.
- [ ] Approval: topological creation, doc seeding with contract and
      dependencies, all-or-nothing rollback, optional planning kick-off.
- [ ] Dependency gating on `implementation`/`yolo` entry points, and
      `releaseDependents` wired into the completion handler and task completion.
- [ ] `syncEpicStatus`.
- [ ] UI: umbrella checkbox, child-projects modal, dashboard badges/chips,
      children strip, epic panel, epic banner, card badges.

## Reference map

| Concern | File |
|---|---|
| Schema + migrations | `reference/server/database/init.sql`, `reference/server/database/db.ts` (`epicsDb`) |
| Breakdown schema | `reference/shared/schemas/epics.ts` |
| Validation, approval, gating, scheduler, epic status | `reference/server/services/epicService.ts` |
| Breakdown prompt | `reference/server/constants/prompts/breakdown.md` |
| Completion script | `reference/scripts/complete-breakdown.ts` |
| HTTP | `reference/server/routes/epics.ts` |
| Epic panel / banner / children modal | `reference/src/components/Epic/` |

## Boundaries (not in this spec)

- What each sub-task does once created — that is the unchanged core loop
  ([`orchestration-loop.md`](../core/orchestration-loop.md)).
- Cross-repo integration testing (spinning up every repo together once all
  sub-tasks are ready). A natural next step, deliberately left out.
- Merging PRs in dependency order. Humans merge; the dependency's PR being
  ready is what unblocks the dependent.
- Nested umbrellas.
