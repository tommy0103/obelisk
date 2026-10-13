# Advanced compatibility queries

These capabilities remain available for existing scripts and workflow-specific
questions. They are outside the default retrieval surface. For ordinary evidence
retrieval, start with the seven helpers in SKILL.md. Full contracts remain in
[api-reference.md](api-reference.md).

## Workflow Tree Compact View

Find the run with `workflows()` under scope, then project `workflowTree()` into
compact fields. Do not return raw `script`, `result_json`, or the full tree.

```js
const runs = workflows({ project: '%quiet-zero%', limit: 30 });
const target = runs.find(w =>
  /session[-_ ]journal/i.test(`${w.workflow_name || ''} ${w.task_id || ''} ${w.run_id || ''}`)
);
if (!target) {
  return {
    found: false,
    candidates: runs.slice(0, 8).map(w => ({
      run_id: w.run_id,
      workflow_name: w.workflow_name,
      timestamp: w.timestamp,
      agent_count: w.agent_count,
    })),
  };
}

const tree = workflowTree(target.run_id);
return {
  run_id: target.run_id,
  workflow_name: target.workflow_name,
  status: tree?.status ?? target.status,
  timestamp: tree?.timestamp ?? target.timestamp,
  agent_count: tree?.agent_count ?? tree?.agents?.length ?? target.agent_count,
  agents: (tree?.agents || []).map(a => ({
    agent_id: a.agent_id,
    phase: a.phase,
    label: a.label,
    state: a.state,
    tokens: a.tokens,
    messageCount: a.messageCount,
  })),
};
```
