# Issue Tracker

Issues are tracked in **Linear** using the integrated Linear MCP tools.

## Workflow

- **Create issue**: use `mcp__linear_create_issue` with `title`, `teamId`, and optional `description`/`priority`/`labels`
- **List issues**: use `mcp__linear_list_issues` with optional `teamId`/`status`/`assigneeId` filters
- **Update issue**: use `mcp__linear_update_issue` with `issueId` and fields to change
- **Search issues**: use `mcp__linear_search_issues` with a text `query`
- **Get issue detail**: use `mcp__linear_get_issue` with `issueId`
- **List teams**: use `mcp__linear_list_teams` to discover team IDs
- **List projects**: use `mcp__linear_list_projects` with optional `teamId` filter

## Conventions

- Always specify `teamId` when creating issues to ensure they land in the correct team
- Use `priority` (0–4) to signal urgency: 0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low
- Include enough context in `description` for an AFK agent to execute without human input when the issue is `ready-for-agent`
