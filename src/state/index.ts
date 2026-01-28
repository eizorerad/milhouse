/**
 * State management module
 *
 * This is the main entry point for all state-related functionality.
 * It exports from specialized modules for better organization and tree-shaking.
 *
 * Module structure:
 * - types.ts: Type definitions and Zod schemas
 * - errors.ts: Custom error classes for state operations
 * - events.ts: State change event system
 * - issues.ts: Issue CRUD operations
 * - tasks.ts: Task CRUD with dependency resolution
 * - graph.ts: Dependency graph builder and topological sort
 * - executions.ts: Execution record management
 * - runs.ts: Run management (create, list, switch, delete)
 * - probes.ts: Probe result storage
 * - compat.ts: Export to external formats
 * - migration.ts: Legacy state migration
 * - manager.ts: Core utilities and backward-compatible re-exports
 */

// Type definitions and schemas
export * from "./types.ts";

// Error classes for state operations
export {
	StateError,
	StateParseError,
	StateLockError,
	StateNotFoundError,
	StateValidationError,
	StateWriteError,
	logStateError,
} from "./errors.ts";

// State events system
export {
	stateEvents,
	onRunPhaseChanged,
	onTaskStatusChanged,
	onTaskStart,
} from "./events.ts";
export type { StateEvent, RunStatsPayload } from "./events.ts";

// Issues module - Issue CRUD operations
export {
	loadIssues,
	saveIssues,
	createIssue,
	readIssue,
	updateIssue,
	batchUpdateIssues,
	deleteIssue,
	filterIssuesByStatus,
	filterIssuesByStatuses,
	getConfirmedIssues,
	getUnvalidatedIssues,
	countIssuesByStatus,
	issueExists,
	countIssues,
	generateIssueId,
	updateIssueWithLock,
	updateIssuesConcurrently,
	updateIssueFromValidation,
} from "./issues.ts";

// Tasks module - Task CRUD with dependency resolution
export {
	generateTaskId,
	loadTasks,
	saveTasks,
	createTask,
	readTask,
	updateTask,
	deleteTask,
	filterTasksByStatus,
	filterTasksByStatuses,
	getPendingTasks,
	getCompletedTasks,
	getFailedTasks,
	getBlockedTasks,
	countTasksByStatus,
	taskExists,
	countTasks,
	getTasksByIssueId,
	getTasksByParallelGroup,
	getParallelGroups,
	areDependenciesSatisfied,
	getReadyTasks,
	getNextPendingTask,
	getDependentTasks,
	getTaskDependencies,
	getTransitiveDependencies,
	hasCircularDependency,
	validateDependencies,
	addDependency,
	removeDependency,
	topologicalSort,
	updateTaskStatus,
	getExecutionOrder,
	updateTaskWithLock,
	updateTaskStatusWithLock,
} from "./tasks.ts";

// Graph module - Dependency graph builder and topological sort
export {
	loadGraph,
	saveGraph,
	createGraphNode,
	readGraphNode,
	updateGraphNode,
	deleteGraphNode,
	graphNodeExists,
	countGraphNodes,
	buildGraphFromTasksArray,
	buildGraphFromTasks,
	topologicalSortNodes,
	topologicalSortGraph,
	assignParallelGroupsToNodes,
	assignParallelGroups,
	getParallelGroups as getGraphParallelGroups,
	getNodesByParallelGroup,
	getExecutionOrder as getGraphExecutionOrder,
	getNodeDependencies,
	getTransitiveDependencies as getGraphTransitiveDependencies,
	getDependentNodes,
	getTransitiveDependents,
	hasCycle,
	wouldCreateCycle,
	findCycleNodes,
	addNodeDependency,
	removeNodeDependency,
	validateGraphDependencies,
	getOrphanNodes,
	getRootNodes,
	getLeafNodes,
	getGraphStats,
} from "./graph.ts";
export type { TopologicalSortResult } from "./graph.ts";

// Executions module - Execution record management
export {
	generateExecutionId,
	loadExecutions,
	saveExecutions,
	createExecution,
	readExecution,
	updateExecution,
	deleteExecution,
	executionExists,
	countExecutions,
	getExecutionsByTaskId,
	getExecutionsByAgentRole,
	getSuccessfulExecutions,
	getFailedExecutions,
	getPendingExecutions,
	getCompletedExecutions,
	getExecutionsWithPRs,
	getExecutionsWithFollowUps,
	getExecutionStats,
	countExecutionsBySuccess,
	getTotalTokenUsage,
	getLatestExecutionForTask,
	getExecutionsInTimeRange,
	getExecutionsSortedByTime,
	getRecentExecutions,
	startExecution,
	completeExecution,
	failExecution,
	addFollowUpTasks,
	deleteExecutionsForTask,
	deleteFailedExecutions,
	deleteExecutionsOlderThan,
	clearAllExecutions,
} from "./executions.ts";

// Runs module - Run management
export {
	getRunsDir,
	getRunsIndexPath,
	getRunDir,
	getRunStateDir,
	getRunMetaPath,
	loadRunsIndex,
	saveRunsIndex,
	loadRunMeta,
	saveRunMeta,
	getCurrentRunId,
	getCurrentRun,
	setCurrentRun,
	generateRunId,
	createRun,
	deleteRun,
	listRuns,
	updateRunPhaseInMeta,
	updateRunStats,
	updateRunMetaWithLock,
	updateRunPhaseInMetaWithLock,
	updateRunStatsWithLock,
	saveRunsIndexWithLock,
	requireActiveRun,
	updateCurrentRunPhase,
	updateCurrentRunStats,
	getCurrentRunPhase,
	hasRuns,
	getStatePathForCurrentRun,
	getPlansPathForCurrentRun,
	getProbesPathForCurrentRun,
	ensureActiveRun,
	cleanupOldRuns,
	parseDuration,
	getDateFromDuration,
} from "./runs.ts";
export type { CleanupOldRunsOptions, CleanupResult } from "./runs.ts";

// Probes module - Probe result storage
export {
	saveProbeResult,
	loadProbeResults,
	loadProbeResult,
	deleteProbeResult,
	getProbeTypes,
	countProbeResults,
	getProbeResultsBySeverity,
} from "./probes.ts";

// Compat module - Export to external formats
export {
	getCompatDir,
	exportToCompat,
	exportToMarkdown,
	exportToCsv,
	exportIssuesToCompat,
	exportStateSnapshot,
} from "./compat.ts";

// Migration module - Legacy state migration
export {
	migrateLegacyToRun,
	hasLegacyState,
	getLegacyStateFiles,
	cleanupLegacyState,
	cloneRunState,
	getMigrationStatus,
} from "./migration.ts";

// History module - State versioning and snapshots
export {
	getHistoryDir,
	getStateHistoryDir,
	ensureHistoryDir,
	generateSnapshotId,
	parseSnapshotId,
	saveStateSnapshot,
	listSnapshots,
	loadSnapshot,
	getLatestSnapshot,
	rollbackState,
	enforceSnapshotLimit,
	deleteSnapshot,
	clearSnapshots,
	clearAllHistory,
	getHistoryStats,
	DEFAULT_HISTORY_CONFIG,
} from "./history.ts";
export type { StateType, SnapshotMeta, Snapshot, HistoryConfig } from "./history.ts";

// Audit module - Audit trail for state changes
export {
	getAuditLogPath,
	appendAuditEntry,
	createAuditEntry,
	getAuditLog,
	getEntityAuditLog,
	getLatestAuditEntry,
	countAuditEntries,
	auditRunCreated,
	auditRunPhaseChanged,
	auditTaskStatusChanged,
	auditIssueStatusChanged,
	auditIssueValidated,
	auditExecutionStarted,
	auditExecutionCompleted,
	auditExecutionFailed,
	auditValidationReportCreated,
	auditStateSnapshotCreated,
	auditStateRollback,
	getAuditStats,
	AUDIT_ACTIONS,
} from "./audit.ts";
export type { AuditLogFilters } from "./audit.ts";

// Validation Index module - Track validation reports
export {
	getValidationIndexPath,
	getValidationReportsDir,
	loadValidationIndex,
	saveValidationIndex,
	addValidationReportToIndex,
	updateValidationIndex,
	getValidationReportsForRun,
	getValidationReportsByIssue,
	getLatestValidationReport,
	getValidationReportsByStatus,
	countValidationReportsByStatus,
	isIssueValidated,
	getUnvalidatedIssueIds,
	removeValidationReportFromIndex,
	clearValidationIndex,
	rebuildValidationIndex,
} from "./validation-index.ts";

// Plan Store module - Run-aware plan operations
export {
	getCurrentPlansDir,
	getLegacyPlansDir,
	ensurePlansDirExists,
	writePlanFile,
	readPlanFile,
	planFileExists,
	listPlanFiles,
	writeIssueWbsPlan,
	readIssueWbsPlan,
	writeIssueWbsJson,
	readIssueWbsJson,
	writeProblemBrief,
	readProblemBrief,
	writeExecutionPlan,
	readExecutionPlan,
	syncLegacyPlansView,
	hasPlans,
	hasLegacyPlansToImport,
	importLegacyPlans,
	createPlanMetadataHeader,
} from "./plan-store.ts";
export type { PlanMetadataOptions } from "./plan-store.ts";

// Core utilities from manager.ts (directory management, run state, etc.)
export {
	MILHOUSE_DIR,
	getMilhouseDir,
	getStatePath,
	getProbesDir,
	getPlansDir,
	isInitialized,
	initializeDir,
	ensureGitignore,
	generateId,
	loadRunState,
	saveRunState,
	createRunState,
	updateRunPhase,
	recordGateResult,
	updateProgress,
} from "./manager.ts";
