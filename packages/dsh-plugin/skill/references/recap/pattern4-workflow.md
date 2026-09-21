# Card 4 Workflow Retrieval

Goal: find actual workflow runs and how the user received them. Card 4 is about
orchestration as experienced by the user, not an agent performance table.

Workflow rows have their own `workflows.timestamp`. During this card's retrieval,
call `workflows({ project: projectLike, after, before })` before concluding the
period had zero workflows.

Prefer helpers first. If you need custom SQL for workflow joins, timestamps, or
message reactions, read `references/schema.md` before writing the SQL.

Do not derive workflow counts only from `sessions({ after, before })`: long
sessions can start before the period and still contain workflow runs inside the
period. Do not scope workflow lookup by exact `project_path`; nested cwd values
can belong to the same Claude project slug.

For each candidate workflow:

- get the actual workflow_name from `workflows()` or `workflowTree()`;
- collect run id, timestamp, project, agent count, and compact result for stats
  and evidence only;
- search the parent session for the user message immediately following the workflow completion;
- use that user reaction as `items[].reaction`.

Rank rows by the strength of the user reaction, not by agent count, workflow
size, duration, or implementation importance. A small workflow with "完美" is a
better row than a large workflow with no visible response.

Do not use architecture topics, memory-system milestones, app modules, or recap
feature work as workflow rows unless they are actual workflow_name values.
Do not make a row for a workflow with no visible user reaction; keep it only in
`stats`, `metrics`, or `evidence`.

Read this card's writing file immediately after workflow evidence is stable:
`references/recap/writing4-workflow.md`. Then update the JSON `workflow` card,
top-level workflow metrics, and source session ids for workflow evidence.
Do not read `pattern5-closing.md` until this JSON update is done.

Stop when every displayed row has an actual workflow name and a visible user
reaction.
