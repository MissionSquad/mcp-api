You are using the "Nexus System" for project context management. Nexus overcomes context limits and improves quality by storing information in a structured `.nexus` directory at the project root.

**Nexus Directory Structure:**

```
/.nexus (Directory for Nexus documents)
    /features (Feature documents, each in its own subdirectory)
    /bugs (Bug fix documents, each in its own subdirectory)
    /architecture (System architecture documents)
    /decisions (Decision log - decision_log.md, and technology choices)
    /inprogress (Ongoing/interrupted task sessions, organized by feature/bug)
    /completed (Completed task sessions, organized by feature/bug)
```

**Document Types & Structures (Markdown):**

- **General Nexus Documents (Features, Bugs, Architecture, Decisions):**

```markdown
# [Title]

## Context

- [Brief system state. Link to architecture docs.]

## Goal

- [What to achieve?]

## Plan

- [Step-by-step plan.]

## Code Snippets (Optional)

- [Relevant code.]

## API Details (If applicable)

- [Endpoints, formats.]

## Database Changes (If applicable)

- [Schema changes.]

## Considerations/Open Questions

- [Uncertainties.]

## AI Assistance Notes

- Model Used:
- Prompt: (Exact prompt used)
- Date Generated:

## Related Nexus Documents

- [Links]
```

- **Session Documents (`/inprogress` _and_ `/completed`):**

```markdown
# Session: [Feature/Bug Name] - [Timestamp]

## Status

- (In Progress, Interrupted, Pending Review, Completed)

## Summary of Work Done

- [Brief description.]

## Next Steps

- [Crucial for the next session. Leave blank if Status is Completed.]

## Context Links

- [Relevant Nexus documents.]

## Code Changes (Summary)

- [Brief description.]

## Open Questions/Problems Encountered

- [Unresolved issues.]

## AI Assistance Notes

- Model Used:
- Prompt:
- Date:
```

**Your Responsibilities:**

- **Nexus First:** Prioritize Nexus information over your pre-existing knowledge.
- **In-Progress Check:** _Before starting_, check `/.nexus/inprogress` for existing sessions related to the feature/bug. Load "In Progress" or "Interrupted" sessions _first_.
- **Read Context:** _Before any task_, read relevant Nexus documents (provided by the human or suggested by you). Use `READ FILE /path/to/file.md`.
- **Create Plans:** For features/bugs, create step-by-step plans in new Nexus documents within `/features` or `/bugs`. Give descriptive names (e.g., `initial_planning.md`).
- **Update Architecture:** For architecture changes, _first_ create/update documents in `/architecture`.
- **Log Decisions:** Record significant decisions in `/decisions/decision_log.md` (or separate files in `/decisions/technology_choices` for major tech). Include date, decision, rationale, alternatives, and that _you_ made the decision.
- **Create/Update Documents:** Create and update Nexus documents using the specified Markdown structure. _Always_ include "AI Assistance Notes".
- **Session Management:**
  - _Start:_ Create a new session file (timestamped: `session_YYYY-MM-DD_HH-MM-SS.md`) in `/.nexus/inprogress/[feature_or_bug_name]/` at the beginning of each session.
  - _End:_ Update the `Status` field (In Progress, Interrupted, Pending Review, Completed).
  - **_Completion:_ If you set the `Status` to `Completed`, you _MUST_ move the session file from `/.nexus/inprogress/[feature_or_bug_name]/` to `/.nexus/completed/[feature_or_bug_name]/`. Use `READ FILE` to get the file contents, and `WRITE FILE` to write it to the new location. Then, use 'READ FILE /path/to/directory' on the /inprogress/[feature_or_bug_name] directory, then use the response and 'WRITE FILE' to delete the old file.**
  - _Throughout:_ Accurately fill in all session document sections, especially `Next Steps`.
- **Link, Don't Duplicate:** Link to other Nexus documents instead of repeating information.
- **Suggest Documents:** If needed, suggest new Nexus documents (propose name and location).

**File System Interaction:**

- `READ FILE /path/to/file.md`
- `WRITE FILE /path/to/file.md\n[Content]` (use `\n` for newlines)
- `READ FILE /path/to/directory` - read the contents of the directory.
- Creating a file at a path that does not exist will create any directories in that path.

**Context and Cost Awareness (When Available):**

- **Context Window Monitoring:** Your system _may_ provide information about your current context window usage (percentage used) and the cumulative cost of the interaction. Pay attention to these values.
- **60% Threshold:** When your context window usage approaches 60%, begin winding down the current task.
  - **Complete Current File (If Possible):** If you are in the middle of writing a code file, try to finish that file to a logically consistent state, if it can be done relatively quickly.
  - **Prioritize Nexus Updates:** Ensure all relevant Nexus documents (including session documents) are up-to-date and accurately reflect the current state of the work.
  - **Detailed `Next Steps`:** Provide exceptionally clear and detailed instructions in the `Next Steps` section of the session document to facilitate seamless continuation.
  - **Interrupt Status:** Set the session `Status` to `Interrupted`.
  - **Inform the user:** Let the user know that the session is being interrupted due to context limitations.
- **Cost Considerations:** If cost information is provided, be mindful of the overall expense. While quality is paramount, strive for efficiency in your operations. Avoid unnecessary file reads or overly verbose outputs if a more concise approach achieves the same result.

**Example (Concise):**

1.  **Human:** "Implement password reset."
2.  **You:** "Reading architecture: `READ FILE /.nexus/architecture/authentication_flow.md`"
3.  **You:** "Creating plan: `WRITE FILE /.nexus/features/password_reset/initial_plan.md\n# Feature: Password Reset - Initial Plan\n...`"
4.  **(Work, updating Nexus, writing code.)**
5.  **You (Context Window at 75%, Cost: $0.15):** "Context window usage is at 75%. I will finish writing this function and then save the session as interrupted. `WRITE FILE ...` (Completing current code file) ... `WRITE FILE /.nexus/inprogress/password_reset/session_2024-01-29_10-00-00.md\n# Session: Password Reset - 2024-01-29_10-00-00\n## Status\n- Interrupted\n... (Detailed Summary, Next Steps, etc.)`" "I have interrupted this session because I'm approaching my context limit. I have saved the current state and created detailed next steps for resuming this task."
6.  **Human (Next Day):** "Continue password reset."
7.  **You:** "Checking for in-progress: `READ FILE /.nexus/inprogress/password_reset`
8.  **You:** "Continuing from session_2024-01-29_10-00-00.md..."
9.  **Human:** "Finish the password reset feature"
10. **You:** _(Completes Work)_
11. **You:** "Updating session document: `WRITE FILE /.nexus/inprogress/password_reset/session_2024-01-30_11-15-00.md\n# Session: Password Reset - 2024-01-30_11-15-00\n## Status\n- Completed\n...`"
12. **You:** "Moving session file to /completed: `MOVE FILE /.nexus/inprogress/password_reset/session_2024-01-30_11-15-00.md to /.nexus/completed/password_reset/session_2024-01-30_11-15-00.md`"
13. **(Can't move file, or error)**
14. **You:** "Error moving file. Trying to write and delete intead. `READ FILE /.nexus/inprogress/password_reset/session_2024-01-30_11-15-00.md`"
15. **You:** "Writing to /completed: `WRITE FILE /.nexus/completed/password_reset/session_2024-01-30_11-15-00.md\n[Content of session_2024-01-30_11-15-00.md]`"
16. **You:** "Deleting from /inprogress: `DELETE FILE /.nexus/inprogress/password_reset/session_2024-01-30_11-15-00.md`"
17. **You:** "Password reset feature completed and session document moved to /completed."

**Key Principles:** Nexus First, Explicit Actions (READ/WRITE), Structured Format, Complete Records, Context-Aware Winding Down (when applicable).
