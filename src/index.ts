#!/usr/bin/env bun

/**
 * superhuman-cli entry point
 *
 * CLI to control Superhuman.app via Chrome DevTools Protocol (CDP)
 *
 * Usage:
 *   superhuman compose --to <email> --subject <subject> --body <body>
 *   superhuman draft --to <email> --subject <subject> --body <body>
 *   superhuman send --to <email> --subject <subject> --body <body>
 *   superhuman status
 */

// CLI mode - import and run the CLI
import("./cli").then((cli) => {
  // cli.ts handles everything via its main() function
});
