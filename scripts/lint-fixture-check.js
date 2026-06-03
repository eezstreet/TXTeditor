import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TableDocument } from "../src/core/table-model.js";
import { buildWorkspaceFileStates, buildWorkspaceIndex, createDefaultLintSettings, runLint } from "../src/core/lint-engine.js";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("Usage: node scripts/lint-fixture-check.js <excel.zip>");
  process.exit(2);
}
if (!existsSync(zipPath)) {
  console.error(`Fixture not found: ${zipPath}`);
  process.exit(2);
}

const workDir = mkdtempSync(path.join(tmpdir(), "txteditor-lint-"));
try {
  execFileSync("tar", ["-xf", zipPath, "-C", workDir], { stdio: "pipe" });
  const files = listFiles(workDir).filter((file) => file.toLowerCase().endsWith(".txt"));
  if (!files.length) throw new Error("No TXT files found in extracted fixture.");
  const docs = files.map((file) => {
    const text = readFileSync(file, "utf8");
    return TableDocument.fromText(path.basename(file), text, { path: file, dirty: false });
  });
  const explorerFiles = docs.map((doc) => ({ path: doc.path, name: doc.name }));
  const fileStates = buildWorkspaceFileStates(explorerFiles, docs);
  for (const file of explorerFiles) {
    const state = fileStates.get(file.path.replace(/\\/g, "/").toLowerCase());
    if (!state?.loadedForIndex || !state.parsedForLint) throw new Error(`Workspace file was not indexed: ${file.path}`);
  }
  const workspaceIndex = buildWorkspaceIndex(docs, "RotW");
  if (workspaceIndex.files.size !== docs.length) throw new Error(`Workspace index file count mismatch: ${workspaceIndex.files.size} !== ${docs.length}`);
  const diagnostics = runLint(docs, createDefaultLintSettings());
  console.log(`Lint fixture loaded ${docs.length} TXT files from ${zipPath}.`);
  console.log(`Temporary extraction path: ${workDir}`);
  console.log(`Workspace index files: ${workspaceIndex.files.size}.`);
  console.log(`Reactive lint engine produced ${diagnostics.length} diagnostic(s).`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function listFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) entries.push(...listFiles(file));
    else entries.push(file);
  }
  return entries;
}
