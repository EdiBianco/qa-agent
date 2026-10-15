# Playbook: reporting to Jira and Slack

The task prompt says **DRY RUN** or **LIVE** and names the Jira project and Slack channel. Obey it.

## Dry run

Write nothing to Jira or Slack. Put every would-be issue and message in `result.json` with `status: "draft"` and the full text under `draft`.

## Live: Jira

Tools are the connector's: load them with ToolSearch (names look like `mcp__claude_ai_Atlassian_MCP__createJiraIssue`). In headless runs the connector can be slow to appear: if no Jira tool shows up, run `sleep 15` and retry up to 3 times. Get the `cloudId` with `getAccessibleAtlassianResources`.

For each finding group:

1. **Fingerprint** it (`SKILL.md`). Label: `qa-fp-<hash>`.
2. **Search first.** JQL: `project = <KEY> AND (labels = "qa-fp-<hash>" OR (summary ~ "<rule keywords>" AND statusCategory != Done))`.
3. **Found, open:** add one comment ("Seen again in run <id> on <date>: <one-line evidence>") and add the `qa-fp-<hash>` label if it is missing. Do not create a duplicate.
4. **Found, Done:** this is a regression. Reopen it (transition to the project's To Do / reopened status) and comment with the evidence.
5. **Not found:** create a Bug.

New issue fields:

| Field | Value |
|---|---|
| Summary | `[QA] <short problem> on <where>` (add `[QA TEST]` instead of `[QA]` for test runs) |
| Type | Bug (use Task for rollups) |
| Priority | critical → Highest, serious → High, moderate → Medium, minor → Low (if the project has the field) |
| Labels | `qa-agent`, `qa-fp-<hash>`, category (`a11y`, `seo`, `links`, `security`, `performance`, `functional`) |
| Description | What was observed (with values), where (URL), how to reproduce, expected result, suggested fix, WCAG criteria if any, run id and run folder |

Limits: at most **15 new issues per run**. Put the rest in one rollup Task that lists them. Group per rule per page group. Never include credentials, tokens, one-time codes or customer data.

## Live: Slack

Post **one** message per run to the project channel (use the channel ID if you were given one) with `slack_send_message`:

```
*QA run: <site or feature>* · <date>
<critical> critical · <serious> serious · <moderate> moderate · <minor> minor
New: <n>   Seen again: <n>   Reopened: <n>
Top findings:
• <summary> (<JIRA-KEY url>)
• ...
Details in the Jira links above.
```

If the project has an alert channel and there is a critical finding, also post a short alert there. No credentials, no customer data. For tenant-isolation findings post only "critical finding, see <JIRA-KEY>".

## After reporting

Fill `result.json`: `jira` with `{key, url, status}` per issue touched, `slack` with `{channel, url, status}`. The Slack message URL comes from the send result.
