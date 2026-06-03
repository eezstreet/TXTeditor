import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TableDocument } from "../src/core/table-model.js";
import { SelectionModel } from "../src/core/selection.js";
import { findInTable } from "../src/core/search.js";
import { UndoManager, makeCellCommand } from "../src/core/undo.js";
import {
  addColumnsCommand,
  addRowsCommand,
  clearRangesCommand,
  copyRange,
  copyRanges,
  deleteColumnsCommand,
  deleteRowsCommand,
  fillSelectionCommand,
  incrementFillCommand,
  insertColumnCommand,
  insertRowCommand,
  pasteTextToRangesCommand,
  pasteTextCommand,
  resizeColumnCommand,
  resizeRowCommand
} from "../src/core/operations.js";
import { movedCell, shouldDrawCellText } from "../src/ui/canvas-grid.js";
import { boundedTableExtent, classifyGridHit, classifyPanePoint, columnColorIndex } from "../src/ui/grid-geometry.js";
import {
  LINT_RULES,
  buildWorkspaceFileStates,
  buildWorkspaceIndex,
  createDefaultLintSettings,
  diagnosticsForDocument,
  groupDiagnosticsByCell,
  lintRuleGroupsForProfile,
  normalizeLintSettings,
  runLint
} from "../src/core/lint-engine.js";
import { formatD2rlintCompatibleExport } from "../src/core/lint-export.js";

function lintDocs(docs, profile = "RotW") {
  const settings = createDefaultLintSettings();
  settings.profile = profile;
  return runLint(docs, settings);
}

function ruleIdsForProfile(profile) {
  return lintRuleGroupsForProfile(profile).flatMap((group) => group.rules.map((rule) => rule.id));
}

test("parses and serializes TSV while preserving CRLF and final newline", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\r\n1\t2\r\n");
  assert.equal(doc.rowCount, 2);
  assert.equal(doc.columnCount, 2);
  assert.equal(doc.lineEnding, "\r\n");
  assert.equal(doc.finalNewline, true);
  assert.equal(doc.toText(), "a\tb\r\n1\t2\r\n");
});

test("initial column sizing is header-first with only capped body influence", () => {
  const doc = TableDocument.fromText("x.txt", "very_long_header_name\tb\nshort\tmedium_content\nshort\t" + "x".repeat(200));
  assert.ok(doc.columnWidths[0] > 120);
  assert.ok(doc.columnWidths[1] < 120);
  assert.ok(doc.columnWidths[1] <= 82 + 40);
});

test("initial column sizing prioritizes the real first row header", () => {
  const doc = TableDocument.fromText("x.txt", "really_long_header_name_that_should_not_clip\tid\nx\t1\ny\t2");
  assert.ok(doc.columnWidths[0] > doc.columnWidths[1] * 2);
  assert.ok(doc.columnWidths[0] >= 300);
});

test("cell commands undo and redo without full table snapshots", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\t2");
  const undo = new UndoManager();
  const command = makeCellCommand("Edit", doc, [{ row: 1, column: 1, value: "42" }]);
  doc.applyCellChanges(command.changes, "after");
  undo.push(command);
  assert.equal(doc.getCell(1, 1), "42");
  undo.undo(doc);
  assert.equal(doc.getCell(1, 1), "2");
  undo.redo(doc);
  assert.equal(doc.getCell(1, 1), "42");
});

test("first row cell edits are undoable and saved as file data", () => {
  const doc = TableDocument.fromText("skills.txt", "pSrvDoFunc\tpSrvHitFunc\n1\t2\n");
  const undo = new UndoManager();
  const command = makeCellCommand("Edit Header Cell", doc, [{ row: 0, column: 0, value: "renamedFunc" }]);
  command.redo(doc);
  undo.push(command);
  assert.equal(doc.getCell(0, 0), "renamedFunc");
  assert.equal(doc.toText(), "renamedFunc\tpSrvHitFunc\n1\t2\n");
  undo.undo(doc);
  assert.equal(doc.getCell(0, 0), "pSrvDoFunc");
});

test("committed multi-character cell edit is one undoable command", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\t2");
  const undo = new UndoManager();
  const command = makeCellCommand("Edit Cell", doc, [{ row: 1, column: 1, value: "apple" }]);
  command.redo(doc);
  undo.push(command);
  assert.equal(doc.getCell(1, 1), "apple");
  undo.undo(doc);
  assert.equal(doc.getCell(1, 1), "2");
});

test("selection supports ranges and select all", () => {
  const selection = new SelectionModel();
  selection.set(3, 4);
  selection.extend(1, 2);
  assert.deepEqual(selection.rect, { top: 1, left: 2, bottom: 3, right: 4 });
  selection.selectAll(10, 6);
  assert.deepEqual(selection.rect, { top: 0, left: 0, bottom: 9, right: 5 });
});

test("selection supports ctrl-style multi-range toggles", () => {
  const selection = new SelectionModel();
  selection.set(1, 1);
  selection.toggleCell(4, 3);
  assert.equal(selection.contains(1, 1), true);
  assert.equal(selection.contains(4, 3), true);
  assert.equal(selection.ranges.length, 2);
  selection.toggleCell(1, 1);
  assert.equal(selection.contains(1, 1), false);
  assert.equal(selection.contains(4, 3), true);
});

test("shift-style extension preserves the original anchor", () => {
  const selection = new SelectionModel();
  selection.set(1, 1);
  selection.toggleCell(4, 4);
  selection.extend(8, 3);
  assert.deepEqual(selection.rect, { top: 1, left: 1, bottom: 8, right: 3 });
});

test("row index highlight is reserved for full-row selection", () => {
  const selection = new SelectionModel();
  selection.set(167, 2);
  assert.equal(selection.hasFullRow(167, 8), false);
  selection.setRow(167, 8);
  assert.equal(selection.hasFullRow(167, 8), true);
});

test("search wraps through the document", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\tneedle\nlast\trow");
  assert.deepEqual(findInTable(doc, "needle", { row: 2, column: 1 }), { row: 1, column: 1 });
});

test("search finds first-row header names as normal cells", () => {
  const doc = TableDocument.fromText("skills.txt", "pSrvDoFunc\tpSrvHitFunc\n1\t2");
  assert.deepEqual(findInTable(doc, "pSrvDoFunc", { row: 1, column: 0 }), { row: 0, column: 0 });
});

test("insert and delete row are grouped undoable commands", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\t2");
  const undo = new UndoManager();
  const insert = insertRowCommand(doc, 1, ["x", "y"]);
  insert.redo(doc);
  undo.push(insert);
  assert.equal(doc.getCell(1, 0), "x");
  undo.undo(doc);
  assert.equal(doc.getCell(1, 0), "1");

  const del = deleteRowsCommand(doc, 1, 1);
  del.redo(doc);
  undo.push(del);
  assert.equal(doc.rowCount, 1);
  undo.undo(doc);
  assert.equal(doc.getCell(1, 1), "2");
});

test("add row and add column append grouped undoable changes", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\t2");
  const undo = new UndoManager();
  const rows = addRowsCommand(doc, 2);
  rows.redo(doc);
  undo.push(rows);
  assert.equal(doc.rowCount, 4);
  undo.undo(doc);
  assert.equal(doc.rowCount, 2);

  const columns = addColumnsCommand(doc, 2);
  columns.redo(doc);
  undo.push(columns);
  assert.equal(doc.columnCount, 4);
  assert.equal(doc.getCell(0, 2), "Column3");
  undo.undo(doc);
  assert.equal(doc.columnCount, 2);
});

test("insert and delete column are grouped undoable commands", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\t2");
  const undo = new UndoManager();
  const insert = insertColumnCommand(doc, 1, "new");
  insert.redo(doc);
  undo.push(insert);
  assert.equal(doc.getCell(0, 1), "new");
  undo.undo(doc);
  assert.equal(doc.getCell(0, 1), "b");

  const del = deleteColumnsCommand(doc, 0, 1);
  del.redo(doc);
  undo.push(del);
  assert.equal(doc.getCell(0, 0), "b");
  undo.undo(doc);
  assert.equal(doc.getCell(0, 0), "a");
});

test("copy and paste range preserve tabular shape", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\tc\n1\t2\t3\n4\t5\t6");
  const copied = copyRange(doc, { top: 1, left: 1, bottom: 2, right: 2 });
  assert.equal(copied, "2\t3\n5\t6");
  const command = pasteTextCommand(doc, { row: 0, column: 0 }, copied);
  command.redo(doc);
  assert.equal(doc.getCell(0, 0), "2");
  assert.equal(doc.getCell(1, 1), "6");
  command.undo(doc);
  assert.equal(doc.getCell(0, 0), "a");
});

test("copy and paste support first-row header cells", () => {
  const doc = TableDocument.fromText("skills.txt", "pSrvDoFunc\tpSrvHitFunc\n1\t2");
  assert.equal(copyRanges(doc, [{ top: 0, left: 0, bottom: 0, right: 0 }]), "pSrvDoFunc");
  const command = pasteTextToRangesCommand(doc, [{ top: 0, left: 1, bottom: 0, right: 1 }], { row: 0, column: 1 }, "renamed");
  command.redo(doc);
  assert.equal(doc.getCell(0, 1), "renamed");
});

test("multi-range clear applies only to selected cells", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\tc\n1\t2\t3\n4\t5\t6");
  clearRangesCommand(doc, [
    { top: 0, left: 0, bottom: 0, right: 0 },
    { top: 2, left: 2, bottom: 2, right: 2 }
  ]).redo(doc);
  assert.equal(doc.getCell(0, 0), "");
  assert.equal(doc.getCell(2, 2), "");
  assert.equal(doc.getCell(1, 1), "2");
});

test("fill copies the top-left selected value over the selection", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\tc\n1\t2\t3\n4\t5\t6");
  const command = fillSelectionCommand(doc, { top: 1, left: 0, bottom: 2, right: 2 });
  command.redo(doc);
  assert.equal(doc.getCell(1, 0), "1");
  assert.equal(doc.getCell(1, 2), "1");
  assert.equal(doc.getCell(2, 1), "1");
  command.undo(doc);
  assert.equal(doc.getCell(2, 1), "5");
});

test("increment fill handles numbers and trailing numeric text", () => {
  const numeric = TableDocument.fromText("x.txt", "v\n1\n\n");
  incrementFillCommand(numeric, { top: 1, left: 0, bottom: 3, right: 0 }).redo(numeric);
  assert.equal(numeric.getCell(1, 0), "1");
  assert.equal(numeric.getCell(2, 0), "2");
  assert.equal(numeric.getCell(3, 0), "3");

  const prefixedNumber = TableDocument.fromText("x.txt", "v\nco1\n\n");
  incrementFillCommand(prefixedNumber, { top: 1, left: 0, bottom: 3, right: 0 }).redo(prefixedNumber);
  assert.equal(prefixedNumber.getCell(1, 0), "co1");
  assert.equal(prefixedNumber.getCell(2, 0), "co2");
  assert.equal(prefixedNumber.getCell(3, 0), "co3");

  const padded = TableDocument.fromText("x.txt", "v\nabc099\n\n");
  incrementFillCommand(padded, { top: 1, left: 0, bottom: 2, right: 0 }).redo(padded);
  assert.equal(padded.getCell(1, 0), "abc099");
  assert.equal(padded.getCell(2, 0), "abc100");
});

test("resize commands are undoable without table snapshots", () => {
  const doc = TableDocument.fromText("x.txt", "a\tb\n1\t2");
  const undo = new UndoManager();
  const col = resizeColumnCommand(1, doc.columnWidths[1], 240);
  col.redo(doc);
  undo.push(col);
  assert.equal(doc.columnWidths[1], 240);
  undo.undo(doc);
  assert.notEqual(doc.columnWidths[1], 240);

  const beforeHeight = doc.rowHeights[1];
  const row = resizeRowCommand(1, beforeHeight, 44);
  row.redo(doc);
  undo.push(row);
  assert.equal(doc.rowHeights[1], 44);
  undo.undo(doc);
  assert.equal(doc.rowHeights[1], beforeHeight);
});

test("explicit auto-fit can still expand for long body content", () => {
  const doc = TableDocument.fromText("x.txt", "Id\nForsaken 01 (Act1 Pit Cave)");
  const initial = doc.columnWidths[0];
  doc.autoFitColumn(0, 300);
  assert.ok(doc.columnWidths[0] > initial);
});

test("keyboard commit movement targets expected cells", () => {
  assert.deepEqual(movedCell({ row: 2, column: 2 }, 0, 1, 10, 10), { row: 2, column: 3 });
  assert.deepEqual(movedCell({ row: 2, column: 2 }, 1, 0, 10, 10), { row: 3, column: 2 });
  assert.deepEqual(movedCell({ row: 0, column: 0 }, -1, -1, 10, 10), { row: 0, column: 0 });
});

test("frozen pane geometry classifies header and frozen regions", () => {
  const base = { rowHeaderWidth: 58, headerHeight: 28, frozenColumnWidth: 120, frozenRowHeight: 26 };
  assert.equal(classifyPanePoint({ ...base, x: 10, y: 10 }), "corner");
  assert.equal(classifyPanePoint({ ...base, x: 100, y: 10 }), "column-header");
  assert.equal(classifyPanePoint({ ...base, x: 10, y: 40 }), "row-header");
  assert.equal(classifyPanePoint({ ...base, x: 220, y: 40 }), "frozen-row");
  assert.equal(classifyPanePoint({ ...base, x: 100, y: 90 }), "frozen-column");
  assert.equal(classifyPanePoint({ ...base, x: 220, y: 90 }), "cell");
});

test("first row data cells are hit as cells, not column headers", () => {
  assert.deepEqual(
    classifyGridHit({ pane: "cell", row: 0, column: 2, x: 250, y: 8 }),
    { kind: "cell", row: 0, column: 2, x: 250, y: 8 }
  );
});

test("frozen first row and first column data cells stay cell targets", () => {
  assert.deepEqual(
    classifyGridHit({ pane: "frozen-row", row: 0, column: 2, x: 250, y: 8 }),
    { kind: "cell", row: 0, column: 2, x: 250, y: 8, frozen: true }
  );
  assert.deepEqual(
    classifyGridHit({ pane: "frozen-column", row: 4, column: 0, x: 72, y: 140 }),
    { kind: "cell", row: 4, column: 0, x: 72, y: 140, frozen: true }
  );
});

test("renderer skips stale text for the active editing cell only", () => {
  const editingCell = { row: 0, column: 1 };
  assert.equal(shouldDrawCellText(0, 1, editingCell), false);
  assert.equal(shouldDrawCellText(0, 0, editingCell), true);
  assert.equal(shouldDrawCellText(1, 1, editingCell), true);
  assert.equal(shouldDrawCellText(0, 1, null), true);
});

test("frozen pane dividers are bounded to visible table content", () => {
  assert.equal(boundedTableExtent({
    fixedExtent: 0,
    scrollableExtent: 260,
    scrollOffset: 0,
    viewportExtent: 900
  }), 260);
  assert.equal(boundedTableExtent({
    fixedExtent: 26,
    scrollableExtent: 5200,
    scrollOffset: 1200,
    viewportExtent: 900
  }), 900);
  assert.equal(boundedTableExtent({
    fixedExtent: 26,
    scrollableExtent: 520,
    scrollOffset: 700,
    viewportExtent: 900
  }), 0);
});

test("column text color cycle is predictable and bounded", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((column) => columnColorIndex(column, 5)), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
});

test("lint rule list excludes JSON rules and has no pending TXT rule placeholders", () => {
  assert.equal(LINT_RULES.some((rule) => rule.id.toLowerCase().startsWith("json/")), false);
  assert.equal(LINT_RULES.every((rule) => rule.implemented), true);
  assert.equal(LINT_RULES.every((rule) => !/not implemented|pending/i.test(rule.note ?? "")), true);
});

test("profile-specific rule groups exactly match RotW and 2.4 TXT rule lists", () => {
  assert.deepEqual(ruleIdsForProfile("RotW"), [
    "Basic/NoDuplicateExcel",
    "Basic/ExcelColumns",
    "Basic/MonEquipLevelOrder",
    "Basic/StringCheck",
    "Basic/NumericBounds",
    "Basic/BooleanFields",
    "Cube/ValidInputs",
    "Cube/ValidOutputs",
    "Cube/ValidOp",
    "Items/ValidSockets",
    "Items/NoIllegalGambling",
    "Items/ValidStatParameters",
    "Level/ValidWarp",
    "Level/ValidWPs",
    "Monsters/ValidChains",
    "Skills/EqualSkills",
    "String/NoUntranslated",
    "TC/ValidTreasure",
    "TC/ValidNegativePicks",
    "TC/ValidProbs"
  ]);
  assert.deepEqual(ruleIdsForProfile("2.4"), [
    "Basic/NoDuplicateExcel",
    "Basic/ExcelColumns",
    "Basic/MissileRangeFieldSemantics",
    "Basic/MonstatsDesecratedTreasureClassSemantics",
    "Basic/MonEquipLevelOrder",
    "Basic/StringCheck",
    "Basic/NumericBounds",
    "Basic/BooleanFields",
    "Cube/ValidInputs",
    "Cube/ValidOutputs",
    "Cube/ValidOp",
    "Items/ValidSockets",
    "Items/NoIllegalGambling",
    "Items/ValidStatParameters",
    "Level/ValidWarp",
    "Level/ValidWPs",
    "Monsters/ValidChains",
    "Skills/EqualSkills",
    "String/NoUntranslated",
    "TC/ValidTreasure",
    "TC/ValidNegativePicks",
    "TC/ValidProbs"
  ]);
});

test("profile-specific rule groups hide 2.4-only rules from RotW", () => {
  const rotwIds = lintRuleGroupsForProfile("RotW").flatMap((group) => group.rules.map((rule) => rule.id));
  const d2r24Ids = lintRuleGroupsForProfile("2.4").flatMap((group) => group.rules.map((rule) => rule.id));
  assert.equal(rotwIds.includes("Basic/MissileRangeFieldSemantics"), false);
  assert.equal(rotwIds.includes("Basic/MonstatsDesecratedTreasureClassSemantics"), false);
  assert.equal(d2r24Ids.includes("Basic/MissileRangeFieldSemantics"), true);
  assert.equal(d2r24Ids.includes("Basic/MonstatsDesecratedTreasureClassSemantics"), true);
});

test("lint settings default to RotW with implemented rules enabled only", () => {
  const settings = normalizeLintSettings({});
  assert.equal(settings.profile, "RotW");
  assert.equal(settings.profiles.RotW.rules["Cube/ValidInputs"].enabled, true);
  assert.equal(settings.profiles.RotW.rules["Items/ValidSockets"].enabled, true);
  assert.equal(settings.profiles.RotW.rules["Basic/MissileRangeFieldSemantics"], undefined);
  assert.equal(settings.profiles["2.4"].rules["Basic/MissileRangeFieldSemantics"].enabled, true);
});

test("lint catches duplicate excel identifiers and maps diagnostics to cells", () => {
  const doc = TableDocument.fromText("armor.txt", "code\tname\nabc\tOne\nabc\tTwo");
  const diagnostics = runLint([doc], createDefaultLintSettings());
  const duplicate = diagnostics.find((item) => item.ruleId === "Basic/NoDuplicateExcel");
  assert.equal(duplicate.fileName, "armor.txt");
  assert.equal(duplicate.rowIndex, 2);
  assert.equal(duplicate.columnIndex, 0);
  assert.equal(groupDiagnosticsByCell(diagnostics).has("2:0"), true);
  assert.equal(diagnosticsForDocument(diagnostics, doc).length > 0, true);
});

test("lint checks numeric bounds, boolean fields, cube rules, and treasure class rules", () => {
  const docs = [
    TableDocument.fromText("misc.txt", "code\tautobelt\nabc\t2"),
    TableDocument.fromText("armor.txt", "code\ncap"),
    TableDocument.fromText("weapons.txt", "code\naxe"),
    TableDocument.fromText("itemtypes.txt", "code\narmo"),
    TableDocument.fromText("itemstatcost.txt", "stat\nstrength"),
    TableDocument.fromText("setitems.txt", "index\nSet Cap"),
    TableDocument.fromText("uniqueitems.txt", "index\nUnique Cap"),
    TableDocument.fromText("cubemod.txt", "code\n"),
    TableDocument.fromText("cubemain.txt", "description\tenabled\tnuminputs\tinput 1\toutput\top\tparam\tvalue\nbad\t1\t2\tcap\tmissing\t5\tbadstat\t"),
    TableDocument.fromText("treasureclassex.txt", "Treasure Class\tPicks\tItem1\tProb1\tItem2\tProb2\nBadTC\t-2\tcap\t1\tmissing\t")
  ];
  const diagnostics = runLint(docs, createDefaultLintSettings());
  assert.ok(diagnostics.some((item) => item.ruleId === "Basic/BooleanFields" && item.columnName === "autobelt"));
  assert.ok(diagnostics.some((item) => item.ruleId === "Cube/ValidInputs" && item.columnName === "numinputs"));
  assert.ok(diagnostics.some((item) => item.ruleId === "Cube/ValidOutputs" && item.columnName === "output"));
  assert.ok(diagnostics.some((item) => item.ruleId === "Cube/ValidOp" && item.columnName === "value"));
  assert.ok(diagnostics.some((item) => item.ruleId === "TC/ValidTreasure" && item.columnName === "Item2"));
  assert.ok(diagnostics.some((item) => item.ruleId === "TC/ValidNegativePicks" && item.columnName === "Picks"));
  assert.ok(diagnostics.some((item) => item.ruleId === "TC/ValidProbs" && item.columnName === "Prob2"));
});

test("remaining D2R TXT lint rules produce concrete diagnostics", () => {
  assert.ok(lintDocs([TableDocument.fromText("cubemain.txt", "description\tenabled\nbad\t1")]).some((item) => item.ruleId === "Basic/ExcelColumns"));
  assert.ok(lintDocs([TableDocument.fromText("monequip.txt", "monster\tlevel\nzombie\t5\nzombie\t10")]).some((item) => item.ruleId === "Basic/MonEquipLevelOrder" && item.columnName === "level"));
  assert.ok(lintDocs([TableDocument.fromText("localstrings.txt", "id\tKey\tenUS\tdeDE\n1\tHello\tHello\tHallo\n1\tOther\tOther\t")]).some((item) => item.ruleId === "Basic/StringCheck" && item.columnName === "id"));
  assert.ok(lintDocs([TableDocument.fromText("localstrings.txt", "id\tKey\tenUS\tdeDE\n1\tHello\tHello\t")]).some((item) => item.ruleId === "String/NoUntranslated" && item.columnName === "deDE"));

  const socketDocs = [
    TableDocument.fromText("itemtypes.txt", "code\tmaxsocketslevelthreshold1\tmaxsocketslevelthreshold2\tmaxsockets1\tmaxsockets2\tmaxsockets3\narmo\t30\t20\t2\t1\t7"),
    TableDocument.fromText("armor.txt", "code\ttype\ttype2\thasinv\tgemsockets\tgemapplytype\tinvwidth\tinvheight\ncap\tarmo\t\t1\t4\t5\t1\t2")
  ];
  const socketDiagnostics = lintDocs(socketDocs);
  assert.ok(socketDiagnostics.some((item) => item.ruleId === "Items/ValidSockets" && item.columnName === "maxsocketslevelthreshold1"));
  assert.ok(socketDiagnostics.some((item) => item.ruleId === "Items/ValidSockets" && item.columnName === "gemapplytype"));

  const gambleDocs = [
    TableDocument.fromText("itemtypes.txt", "code\tequiv1\tequiv2\nchar\t\t\ncharm\tchar\t"),
    TableDocument.fromText("misc.txt", "code\ttype\ttype2\ncm1\tcharm\t"),
    TableDocument.fromText("gamble.txt", "code\ncm1")
  ];
  assert.ok(lintDocs(gambleDocs).some((item) => item.ruleId === "Items/NoIllegalGambling" && item.columnName === "code"));

  const statDocs = [
    TableDocument.fromText("properties.txt", "code\tfunc1\tstat1\nbadprop\t1\titem_strength"),
    TableDocument.fromText("itemstatcost.txt", "stat\tsave bits\tsave add\tsigned\tencode\nitem_strength\t2\t0\t0\t0"),
    TableDocument.fromText("uniqueitems.txt", "index\tprop1\tpar1\tmin1\tmax1\nBad Unique\tbadprop\t\t0\t5")
  ];
  assert.ok(lintDocs(statDocs).some((item) => item.ruleId === "Items/ValidStatParameters" && item.columnName === "max1"));

  const levelDocs = [
    TableDocument.fromText("levels.txt", "id\tname\tvis0\twarp0\twaypoint\n1\tOne\t2\t5\t1\n2\tTwo\t0\t0\t1"),
    TableDocument.fromText("lvlwarp.txt", "name\nWarp Zero")
  ];
  const levelDiagnostics = lintDocs(levelDocs);
  assert.ok(levelDiagnostics.some((item) => item.ruleId === "Level/ValidWarp" && item.columnName === "vis0"));
  assert.ok(levelDiagnostics.some((item) => item.ruleId === "Level/ValidWPs" && item.columnName === "waypoint"));

  assert.ok(lintDocs([TableDocument.fromText("monstats.txt", "id\tbaseid\tnextinclass\tboss\tprimeevil\nzombie\tzombie\tmissing\t0\t0")]).some((item) => item.ruleId === "Monsters/ValidChains" && item.columnName === "nextinclass"));
  assert.ok(lintDocs([
    TableDocument.fromText("skills.txt", "skill\tcharclass\nA Skill\tama\nS Skill 1\tsor\nS Skill 2\tsor"),
    TableDocument.fromText("playerclass.txt", "code\nama\nsor")
  ]).some((item) => item.ruleId === "Skills/EqualSkills" && item.columnName === "code"));
});

test("2.4-only TXT lint rules are implemented and hidden from RotW", () => {
  const docs = [
    TableDocument.fromText("missiles.txt", "missile\trange\nbolt\tpar3"),
    TableDocument.fromText("monstats.txt", "id\ttreasureclassdesecrated\ttreasureclassdesecratedchamp\ttreasureclassdesecratedunique\nzombie\t\tAct 1 Champ\t")
  ];
  assert.equal(lintDocs(docs, "RotW").some((item) => item.ruleId === "Basic/MissileRangeFieldSemantics" || item.ruleId === "Basic/MonstatsDesecratedTreasureClassSemantics"), false);
  const diagnostics = lintDocs(docs, "2.4");
  assert.ok(diagnostics.some((item) => item.ruleId === "Basic/MissileRangeFieldSemantics" && item.columnName === "range"));
  assert.ok(diagnostics.some((item) => item.ruleId === "Basic/MonstatsDesecratedTreasureClassSemantics" && item.columnName === "treasureclassdesecrated"));
});

test("single-file lint avoids cross-file cube reference false positives", () => {
  const doc = TableDocument.fromText("cubemain.txt", "description\tenabled\tnuminputs\tinput 1\toutput\top\tparam\tvalue\nok\t1\t1\tunknown\talso_unknown\t0\t\t");
  const diagnostics = runLint([doc], createDefaultLintSettings());
  assert.equal(diagnostics.some((item) => item.ruleId === "Cube/ValidInputs" || item.ruleId === "Cube/ValidOutputs"), false);
});

test("lint profile affects D2R 2.4 missile range semantics", () => {
  const doc = TableDocument.fromText("missiles.txt", "missile\trange\nbolt\tpar3");
  assert.equal(runLint([doc], createDefaultLintSettings()).some((item) => item.ruleId === "Basic/MissileRangeFieldSemantics"), false);
  const settings = createDefaultLintSettings();
  settings.profile = "2.4";
  settings.profiles["2.4"].rules["Basic/MissileRangeFieldSemantics"].enabled = true;
  assert.equal(runLint([doc], settings).some((item) => item.ruleId === "Basic/MissileRangeFieldSemantics"), true);
});

test("fixed lint diagnostics disappear after re-running on edited data", () => {
  const doc = TableDocument.fromText("misc.txt", "code\tautobelt\nabc\t2");
  assert.equal(runLint([doc], createDefaultLintSettings()).some((item) => item.ruleId === "Basic/BooleanFields"), true);
  doc.setCell(1, 1, "1");
  assert.equal(runLint([doc], createDefaultLintSettings()).some((item) => item.ruleId === "Basic/BooleanFields"), false);
});

test("lint diagnostics expose semantic labels and active profile", () => {
  const doc = TableDocument.fromText("treasureclassex.txt", "Treasure Class\tPicks\tItem1\tProb1\nAct 1 (N) Unique B\t-2\tcap\t1");
  const diagnostic = runLint([doc], createDefaultLintSettings()).find((item) => item.ruleId === "TC/ValidNegativePicks");
  assert.equal(diagnostic.profile, "RotW");
  assert.equal(diagnostic.rowLabel, "Act 1 (N) Unique B");
  assert.equal(diagnostic.columnName, "Picks");
  assert.equal(diagnostic.locationLabel, "Act 1 (N) Unique B > Picks");
  assert.equal(diagnostic.primaryLocationLabel, "Act 1 (N) Unique B > Picks");
  assert.equal(diagnostic.technicalLocationLabel, "R2:C2");
  assert.equal(diagnostic.offendingValue, "-2");
});

test("d2rlint-compatible export uses WARN tab-separated diagnostics", () => {
  const doc = TableDocument.fromText("treasureclassex.txt", "Treasure Class\tPicks\tItem1\tProb1\nAct 1 (N) Unique B\t-2\tcap\t1");
  const diagnostics = runLint([doc], createDefaultLintSettings());
  const text = formatD2rlintCompatibleExport({ diagnostics });
  assert.match(text, /^WARN\tTC\/ValidNegativePicks\ttreasureclassex\.txt, line 2: 'picks' \(-2\) doesn't match negative sum of probs \(-1\) for 'Act 1 \(N\) Unique B'$/m);
});

test("disabling a lint rule removes that rule's diagnostics", () => {
  const doc = TableDocument.fromText("armor.txt", "code\tname\nabc\tOne\nabc\tTwo");
  const settings = createDefaultLintSettings();
  assert.equal(runLint([doc], settings).some((item) => item.ruleId === "Basic/NoDuplicateExcel"), true);
  settings.profiles.RotW.rules["Basic/NoDuplicateExcel"].enabled = false;
  assert.equal(runLint([doc], settings).some((item) => item.ruleId === "Basic/NoDuplicateExcel"), false);
});

test("profile switching replaces previous profile diagnostics", () => {
  const doc = TableDocument.fromText("missiles.txt", "missile\trange\nbolt\tpar3");
  const settings = createDefaultLintSettings();
  assert.equal(runLint([doc], settings).some((item) => item.profile === "RotW" && item.ruleId === "Basic/MissileRangeFieldSemantics"), false);
  settings.profile = "2.4";
  settings.profiles["2.4"].rules["Basic/MissileRangeFieldSemantics"].enabled = true;
  const diagnostics = runLint([doc], settings);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].profile, "2.4");
  assert.equal(diagnostics[0].locationLabel, "bolt > range");
});

test("workspace lint can report diagnostics for files that are not the active document", () => {
  const activeDoc = TableDocument.fromText("misc.txt", "code\tautobelt\nok\t1");
  const workspaceOnlyDoc = TableDocument.fromText("armor.txt", "code\tname\nabc\tOne\nabc\tTwo");
  const diagnostics = runLint([activeDoc, workspaceOnlyDoc], createDefaultLintSettings());
  assert.equal(diagnosticsForDocument(diagnostics, activeDoc).length, 0);
  assert.equal(diagnosticsForDocument(diagnostics, workspaceOnlyDoc).some((item) => item.ruleId === "Basic/NoDuplicateExcel"), true);
});

test("workspace index represents every Explorer txt as loaded and parsed", () => {
  const explorerFiles = [
    { path: "fixtures/excel/armor.txt", name: "armor.txt" },
    { path: "fixtures/excel/misc.txt", name: "misc.txt" },
    { path: "fixtures/excel/cubemain.txt", name: "cubemain.txt" }
  ];
  const docs = [
    TableDocument.fromText("armor.txt", "code\ncap", { path: "fixtures/excel/armor.txt" }),
    TableDocument.fromText("misc.txt", "code\nhpot", { path: "fixtures/excel/misc.txt" }),
    TableDocument.fromText("cubemain.txt", "description\tenabled\tnuminputs\tinput 1\toutput\top\tparam\tvalue\nrecipe\t1\t1\thpot\tcap\t0\t\t", { path: "fixtures/excel/cubemain.txt" })
  ];
  const fileStates = buildWorkspaceFileStates(explorerFiles, docs);
  assert.equal(fileStates.size, explorerFiles.length);
  for (const file of explorerFiles) {
    const state = fileStates.get(file.path.toLowerCase());
    assert.equal(state.loadedForIndex, true);
    assert.equal(state.parsedForLint, true);
  }
  const index = buildWorkspaceIndex(docs, "RotW");
  assert.equal(index.files.size, docs.length);
  assert.equal(index.tablesByName.has("cubemain.txt"), true);
  assert.equal(index.itemCodes.has("hpot"), true);
  assert.equal(index.itemCodes.has("cap"), true);
  assert.equal(index.rowLabelsByFile.get("fixtures/excel/cubemain.txt").get(1), "recipe");
  assert.equal(runLint(docs, createDefaultLintSettings()).some((item) => item.ruleId === "Cube/ValidInputs"), false);
});

test("workspace file states keep parse errors visible instead of silently ignoring files", () => {
  const explorerFiles = [{ path: "fixtures/excel/bad.txt", name: "bad.txt" }];
  const errors = new Map([["fixtures/excel/bad.txt", "Unable to parse"]]);
  const fileStates = buildWorkspaceFileStates(explorerFiles, [], errors);
  const state = fileStates.get("fixtures/excel/bad.txt");
  assert.equal(state.loadedForIndex, true);
  assert.equal(state.parsedForLint, false);
  assert.equal(state.parseError, "Unable to parse");
});

test("lint controls live in the bottom Problems panel, not the main toolbar", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const toolbar = html.match(/<section class="toolbar">([\s\S]*?)<\/section>/)?.[1] ?? "";
  const problems = html.match(/<section id="problemsPanel"[\s\S]*?<\/section>/)?.[0] ?? "";
  for (const command of ["toggle-lint", "toggle-lint-rules"]) {
    assert.equal(toolbar.includes(command), false);
    assert.equal(problems.includes(command), true);
  }
  for (const removed of ["run-lint", "toggle-auto-lint", "Run Lint", "Auto Lint", "export-lint-txt", "export-lint-txt-d2rlint", "Export Lint TXT", "Export d2rlint TXT"]) {
    assert.equal(html.includes(removed), false);
  }
  assert.equal(problems.includes("lintProfileSelect"), true);
  assert.equal(problems.includes("problemsResizer"), true);
  assert.equal(html.includes("sidebarResizer"), true);
});

test("Open File and Open Folder sidebar buttons are constrained to one line", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /<button data-command="open-file">Open File<\/button>/);
  assert.match(html, /<button data-command="open-folder">Open Folder<\/button>/);
  assert.match(css, /--sidebar-width:\s*260px/);
  assert.match(css, /\.sidebar\s*\{[\s\S]*min-width:\s*260px/);
  assert.match(css, /\.sidebar-actions button\s*\{[\s\S]*white-space:\s*nowrap/);
  assert.match(app, /const MIN_SIDEBAR_WIDTH = 260/);
  assert.match(app, /clamp\(Math\.round\(width\), MIN_SIDEBAR_WIDTH, 520\)/);
});

test("app source has real Explorer and Problems toggles with persisted resize state", () => {
  const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(source, /async function toggleExplorerPane\(\)/);
  assert.match(source, /async function toggleProblemsPanel\(\)/);
  assert.match(source, /txteditor\.sidebarWidth/);
  assert.match(source, /txteditor\.problemsHeight/);
  assert.match(source, /state\.problemsVisible/);
  assert.match(source, /ensureWorkspaceIndexed/);
  assert.match(source, /cancelLintJobs/);
});
