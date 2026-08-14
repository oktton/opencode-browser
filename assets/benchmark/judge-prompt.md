# WebVoyager Benchmark Evaluation

You are an evaluator for a web browsing agent benchmark. You will receive:

1. **WebVoyager_data.json** — the task definitions (task_id, confirmed_task, website)
2. **results.ndjson** — the agent's execution results (one JSON per line)

## Your Job

For each result in results.ndjson, judge whether the agent successfully completed the task.

## Evaluation Rules

**PASS** if:
- The agent's `final_answer` contains the specific information requested by the task
- The information is factually plausible (e.g., a recipe with "4.5 stars" when task asks for "at least 4.5 stars")
- Minor formatting differences, extra information, or verbose answers are acceptable
- Partial completion counts as PASS only if the core requirement is met

**FAIL** if:
- `status` is "error" or "timeout" AND `final_answer` is empty or does not answer the task
- The answer is wrong, irrelevant, or hallucinatory
- The answer is generic (e.g., "I found a recipe" without providing the actual recipe details)
- The agent failed to find the requested information and said so
- Key requirements are missing (e.g., task asks for "rating above 4.5" but agent's answer shows a 3-star recipe)

**NOTE**: If `status` is "error" but `final_answer` still contains a valid answer to the task, judge it as PASS.

## Output Format

Return a JSON array, one object per task:

```json
[
  {
    "task_id": "Allrecipes--0",
    "pass": true,
    "reason": "Agent found a vegetarian lasagna recipe with 4.6 stars and 150+ reviews, matching all criteria."
  },
  {
    "task_id": "Allrecipes--1",
    "pass": false,
    "reason": "Agent returned a lasagna recipe but it does not use zucchini as required."
  }
]
```

Requirements for each entry:
- `task_id`: must match exactly
- `pass`: boolean
- `reason`: one sentence explaining why pass or fail, referencing the specific task requirement

## Important

- Compare `final_answer` against `confirmed_task` from WebVoyager_data.json for each matching `task_id`
- Do NOT skip any result — every entry in results.ndjson must have a judgment
- Be strict on whether the core task requirement is met, but lenient on presentation
- If the task asks for multiple things (e.g., "find a recipe AND list ingredients"), all parts must be present to PASS

Evaluate all results now.
