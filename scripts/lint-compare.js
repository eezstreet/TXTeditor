import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TableDocument } from "../src/core/table-model.js";
import { createDefaultLintSettings, runLint } from "../src/core/lint-engine.js";
import { formatD2rlintCompatibleExport } from "../src/core/lint-export.js";

const [excelZipPath, expectedPath, ...rest] = process.argv.slice(2);
const writeIndex = rest.indexOf("--write");
const writePath = writeIndex >= 0 ? rest[writeIndex + 1] : "";

if (!excelZipPath || !expectedPath) {
  console.error("Usage: node scripts/lint-compare.js <excel-fixture.zip> <d2rlint-output.txt|lint-report.zip> [--write actual-output.txt]");
  process.exit(2);
}
if (!existsSync(excelZipPath)) fail(`TXT fixture not found: ${excelZipPath}`, 2);
if (!existsSync(expectedPath)) fail(`Expected lint output not found: ${expectedPath}`, 2);

const tempDirs = [];
try {
  const documents = loadTxtZip(excelZipPath);
  const diagnostics = runLint(documents, createDefaultLintSettings());
  const actualText = formatD2rlintCompatibleExport({ diagnostics });
  if (writePath) {
    mkdirSync(path.dirname(path.resolve(writePath)), { recursive: true });
    writeFileSync(writePath, actualText, "utf8");
  }

  const expectedText = loadExpectedText(expectedPath);
  const expected = parseD2rlintOutput(expectedText);
  const actual = parseD2rlintOutput(actualText);
  const comparison = compareRecords(expected.records, actual.records);

  console.log(`TXT files: ${documents.length}`);
  console.log(`Expected warnings: ${expected.records.length}`);
  console.log(`Actual warnings: ${actual.records.length}`);
  if (writePath) console.log(`Actual compatible export: ${path.resolve(writePath)}`);
  printRuleTable(expected.ruleCounts, actual.ruleCounts);
  printExamples("Missing", comparison.missing);
  printExamples("Extra", comparison.extra);

  if (comparison.missing.length || comparison.extra.length) process.exit(1);
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

function loadTxtZip(zipPath) {
  const workDir = mkdtempSync(path.join(tmpdir(), "txteditor-lint-fixture-"));
  tempDirs.push(workDir);
  execFileSync("tar", ["-xf", zipPath, "-C", workDir], { stdio: "pipe" });
  const files = listFiles(workDir).filter((file) => file.toLowerCase().endsWith(".txt")).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  if (!files.length) fail(`No TXT files found in ${zipPath}`, 2);
  return files.map((file) => TableDocument.fromText(path.basename(file), readFileSync(file, "utf8"), { path: file, dirty: false }));
}

function loadExpectedText(filePath) {
  if (!/\.zip$/i.test(filePath)) return readFileSync(filePath, "utf8");
  const workDir = mkdtempSync(path.join(tmpdir(), "txteditor-lint-report-"));
  tempDirs.push(workDir);
  execFileSync("tar", ["-xf", filePath, "-C", workDir], { stdio: "pipe" });
  const output = listFiles(workDir).find((file) => normalizeSlashes(file).endsWith("/original lint/output.txt"));
  if (!output) fail(`original lint/output.txt not found in ${filePath}`, 2);
  return readFileSync(output, "utf8");
}

function parseD2rlintOutput(text) {
  const records = [];
  const ruleCounts = new Map();
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line || line.startsWith("Log started")) continue;
    const [severity, rule, ...messageParts] = line.split("\t");
    if (severity !== "WARN" || !rule || !messageParts.length) continue;
    const message = messageParts.join("\t");
    const key = `${severity}\t${rule}\t${message}`;
    records.push({ severity, rule, message, key });
    ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
  }
  return { records, ruleCounts };
}

function compareRecords(expected, actual) {
  const expectedCounts = countByKey(expected);
  const actualCounts = countByKey(actual);
  const missing = [];
  const extra = [];
  for (const record of expected) {
    const available = actualCounts.get(record.key) ?? 0;
    const consumed = expectedCounts.get(`__used:${record.key}`) ?? 0;
    if (consumed < available) {
      expectedCounts.set(`__used:${record.key}`, consumed + 1);
    } else {
      missing.push(record);
    }
  }
  for (const record of actual) {
    const wanted = expectedCounts.get(record.key) ?? 0;
    const consumed = actualCounts.get(`__used:${record.key}`) ?? 0;
    if (consumed < wanted) {
      actualCounts.set(`__used:${record.key}`, consumed + 1);
    } else {
      extra.push(record);
    }
  }
  return { missing, extra };
}

function countByKey(records) {
  const counts = new Map();
  for (const record of records) counts.set(record.key, (counts.get(record.key) ?? 0) + 1);
  return counts;
}

function printRuleTable(expectedCounts, actualCounts) {
  const rules = [...new Set([...expectedCounts.keys(), ...actualCounts.keys()])].sort();
  console.log("Rule\tExpected\tActual");
  for (const rule of rules) {
    console.log(`${rule}\t${expectedCounts.get(rule) ?? 0}\t${actualCounts.get(rule) ?? 0}`);
  }
}

function printExamples(label, records) {
  console.log(`${label}: ${records.length}`);
  for (const record of records.slice(0, 10)) console.log(`${label}\t${record.rule}\t${record.message}`);
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

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
