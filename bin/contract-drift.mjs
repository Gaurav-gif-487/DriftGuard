#!/usr/bin/env node
// Thin launcher so `npx driftguard` works after `npm run build`.
// Points at the compiled output rather than re-parsing TypeScript on every
// invocation, which matters for the tool's own <300ms performance budget.
import { main } from "../dist/cli.js";
main(process.argv.slice(2)).then((code) => process.exit(code));
