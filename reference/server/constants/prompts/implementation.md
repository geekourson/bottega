@agent-Implement Read the task documentation at `{{taskDocPath}}` and implement the unchecked items from the To-Do List.

## Before starting

Read `{{taskDocPath}}` in full. Then check:

- **If no `## To-Do List` section exists, or the To-Do List has no items at all** → the plan was not written. Do NOT implement anything. Use AskUserQuestion to notify the user: "No To-Do List found in the task doc — the planification agent may not have completed. Please re-run the planification agent."
- **If a `## Review Findings` section exists** → read it carefully and address any `Issues to Address` from the previous review before continuing with unchecked items.

## Implementation

Implement all unchecked items (`[ ]`) from the To-Do List in order. Mark each item as completed (`[x]`) immediately after completing it. Do NOT ask questions — proceed autonomously.

## After implementing

Check if ALL To-Do items are now marked `[x]`.

- If **all complete** → stop. The review agent will verify and decide next steps.
- If **some remain unchecked** after your best effort (e.g. compilation error blocking progress, unclear dependency) → leave them unchecked, add a brief note in the task doc explaining what blocked you, and stop. Do NOT keep retrying the same failing step — let the review agent assess.

Start implementing now.
