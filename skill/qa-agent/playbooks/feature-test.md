# Playbook: check a build or feature

Use when the task says what changed ("new filters panel", "pricing page redesign", a ticket key or release notes).

1. **Understand the change.** Read the instructions and any linked ticket or release notes (Jira connector: fetch the issue; read acceptance criteria). Write 3-8 concrete acceptance checks in the form *Given / When / Then*, each with the URL or screen it applies to.
2. **Run the checks.**
   - Static pages: `curl` plus the relevant part of `scripts/site-audit.js` (run it with `--max 5` on the affected URLs).
   - Interactive behavior: a browser tool if available. Exercise the happy path, one error path, keyboard operation, and a narrow (375px) viewport.
   - Always add a quick regression pass over the pages around the change (links, labels, console errors).
3. **Record pass or fail per check** with evidence (observed value, screenshot path in the run folder).
4. **Report.** Failures become findings (category `functional` unless one of the others fits). Passing checks are summarised in `summary` only. If a ticket key was given, add one comment to that ticket with the pass/fail table (live runs only) instead of creating new issues for failures that belong to the same ticket; create new issues only for unrelated defects.
5. **Say what you did not test** under `blocked`: environments, roles, browsers, devices.
