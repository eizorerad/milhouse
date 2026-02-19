/**
 * Report module -- barrel exports
 */

export { generateJsonReport, writeJsonReport } from "./json-report.ts";
export type { JsonRunReport } from "./json-report.ts";

export { generateMarkdownReport, writeMarkdownReport } from "./markdown-report.ts";

export { generateReport, autoGenerateReport } from "./generator.ts";
export type { GenerateReportOptions, ReportResult } from "./generator.ts";
