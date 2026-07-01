@agent-Implement Read the task documentation at `{{taskDocPath}}` and implement the unchecked items from the To-Do List.

## Before starting

Read `{{taskDocPath}}` in full. Then check:

- **If no `## To-Do List` section exists, or the To-Do List has no items at all** → the plan was not written. Do NOT implement anything. Use AskUserQuestion to notify the user: "No To-Do List found in the task doc — the planification agent may not have completed. Please re-run the planification agent."
- **If a `## Review Findings` section exists** → read it carefully and address any `Issues to Address` from the previous review before continuing with unchecked items.

## Working directory — stay put

You are ALREADY in the correct working directory for this task, and every change you make belongs right here.

- Do NOT `cd` into a different copy or checkout of the repository.
- Do NOT `cp`, `mv`, or `rsync` your files into another directory to "sync", "publish", or "finish" them, and do NOT run `git` or `rm` against another checkout. Your commits in the current directory ARE the deliverable — integration into the main branch happens later, automatically, via pull request. Copying files elsewhere corrupts other work and will be blocked.
- When you verify your work (`git status`, `git diff`, running tests), run the commands from the current directory — never `cd` elsewhere first.

## Implementation

Implement all unchecked items (`[ ]`) from the To-Do List in order. Mark each item as completed (`[x]`) immediately after completing it. Do NOT ask questions — proceed autonomously.

## After implementing

Check if ALL To-Do items are now marked `[x]`.

- If **all complete** → stop. The review agent will verify and decide next steps.
- If **some remain unchecked** after your best effort (e.g. compilation error blocking progress, unclear dependency) → leave them unchecked, add a brief note in the task doc explaining what blocked you, and stop. Do NOT keep retrying the same failing step — let the review agent assess.

Start implementing now.
