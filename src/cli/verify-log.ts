#!/usr/bin/env node
import { verifyLog } from "../audit/verify.js";

const path = process.argv[2] ?? process.env.AUDIT_LOG_PATH;
if (!path) {
  process.stderr.write("usage: verify-log [path]   (defaults to $AUDIT_LOG_PATH)\n");
  process.exit(2);
}

let result;
try {
  result = verifyLog(path);
} catch (e) {
  process.stderr.write(`verify-log: cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}\n`);
  process.exit(2);
}

if (result.ok) {
  const count = result.entries === 0 ? "empty log, nothing to verify" : `${result.entries} entries, chain intact`;
  process.stdout.write(`OK  ${path}: ${count}\n`);
  if (result.entries > 0) process.stdout.write(`    head: ${result.head}\n`);
  process.exit(0);
}
process.stdout.write(`FAIL  ${path}\n`);
process.stdout.write(`    first bad entry: line ${result.line} (seq ${result.seq})\n`);
process.stdout.write(`    problem: ${result.problem}\n`);
process.stdout.write(`    ${result.entries} earlier entries verified\n`);
process.exit(1);
