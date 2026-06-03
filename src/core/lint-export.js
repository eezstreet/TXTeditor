// Development-only formatter for the lint parity comparator.
// Rule messages are shaped to match d2rlint by eezstreet (GPLv3).

export function formatD2rlintCompatibleExport({ diagnostics = [] } = {}) {
  const sortedDiagnostics = [...diagnostics].sort(compareD2rlintDiagnostics);
  return `${sortedDiagnostics.map(formatD2rlintDiagnosticLine).join("\n")}${sortedDiagnostics.length ? "\n" : ""}`;
}

export function compareD2rlintDiagnostics(a, b) {
  return String(a.ruleId ?? "").localeCompare(String(b.ruleId ?? "")) ||
    String(a.fileName ?? "").localeCompare(String(b.fileName ?? "")) ||
    numericExportValue(a.d2rSortLine) - numericExportValue(b.d2rSortLine) ||
    numericExportValue(a.rowIndex) - numericExportValue(b.rowIndex) ||
    numericExportValue(a.columnIndex) - numericExportValue(b.columnIndex) ||
    String(d2rlintMessage(a)).localeCompare(String(d2rlintMessage(b)));
}

function formatD2rlintDiagnosticLine(diagnostic) {
  return `WARN\t${field(diagnostic.ruleId)}\t${d2rlintMessage(diagnostic)}`;
}

function d2rlintMessage(diagnostic) {
  if (diagnostic.d2rMessage) return diagnostic.d2rMessage;
  const row = rowNumber(diagnostic);
  const location = row ? `${field(diagnostic.fileName)}, line ${row}: ` : `${field(diagnostic.fileName)} - `;
  return `${location}${diagnostic.message || ""}`;
}

function rowNumber(diagnostic) {
  return Number.isFinite(diagnostic.rowIndex) ? diagnostic.rowIndex + 1 : "";
}

function numericExportValue(value) {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function field(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
