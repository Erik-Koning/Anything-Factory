#!/usr/bin/env node
// The MCP server a member with Ditto starts (lib/ditto.ts): the operator's own Ditto server, given the team's token
// from the Keychain and run in the member's folder. Named in <run>/mcp/ditto.json, which the member's Claude Code is
// started with; the team's name is its one argument.
import { launch } from "../../lib/ditto.ts";

process.exitCode = await launch(process.argv[2] ?? process.env.A6G_TEAM ?? "");
