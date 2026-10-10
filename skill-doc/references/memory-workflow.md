# Obelisk Memory Workflow

Read this when saving, archiving, or updating persistent memory. Retrieval and
recall are read-only; persistent writes run locally through `obelisk --attune`.

## Authorization

A durable conclusion is a candidate for memory when future sessions are likely
to reuse it and active memories do not already cover it. Examples include
design decisions, project conventions, abandoned alternatives, recurring
failure causes, and conclusions supported by multiple evidence points.
One-off lookups, uncertain findings, and duplicates are not candidates.

Offer briefly and wait for approval before writing a markdown memory file or
mutating a record. Resolve existing user authorization or ambiguous matches
using the [memory approval contract](api-reference.md#memory-mutation-approval).
If you discover a possible conflict yourself, answer from current evidence and
ask before archiving or replacing the memory.

## Save

1. Use a normal `--query` script to obtain source session/message IDs and check
   existing memories. Retrieval helpers are unavailable inside `--attune`.
2. After approval, write the markdown file. Prefer a project-relative path such
   as `.obelisk/memories/design-decision.md`, paired with the source session ID.
3. Register the existing file with `remember()` in a narrow `--attune` script.
   Write its summary in English, with the decision, reasoning, alternatives,
   and constraints so recall can judge relevance without loading the file.
   Include the source message range; add anchors only for explicit recall
   surfaces such as associated files.
4. Confirm the returned registration record before reporting success.

For a copyable registration script, read
[Attune Approved Memory](query-patterns.md#attune-approved-memory).
For path resolution, validation, parameters, and return fields, read the
[mutation API](api-reference.md#memory-mutation-helpers).

## Archive or update

First identify the exact memory ID with a normal query. Run `forget()` to
archive the approved record; the markdown file remains and active recall omits
the record. Updates archive the old record and write/register a replacement
under the same user authorization. Records survive index rebuilds and are never
changed automatically.

Use [Forget Approved Memory](query-patterns.md#forget-approved-memory) or
[Update Approved Memory](query-patterns.md#update-approved-memory) for the
corresponding script; exact archive semantics belong to the mutation API.
