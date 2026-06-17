/**
 * oh-my-codex - Multi-agent orchestration for OpenAI Codex CLI
 *
 * This package provides:
 * - 30+ specialized agent prompts as Codex CLI slash commands
 * - 35+ workflow skills as SKILL.md files
 * - AGENTS.md orchestration brain
 * - MCP servers for state management, project memory, and notepad
 * - CLI tool (omx) for setup, diagnostics, and management
 * - Notification hooks for workflow tracking
 */

export { setup } from './cli/setup.js';
export { doctor } from './cli/doctor.js';
export { version } from './cli/version.js';
export { mergeConfig } from './config/generator.js';
export { AGENT_DEFINITIONS, type AgentDefinition } from './agents/definitions.js';
export { generateAgentToml, installNativeAgentConfigs } from './agents/native-config.js';
export { hudCommand } from './hud/index.js';
export {
  buildDirectSessionArgs,
  captureTmuxPaneTail,
  findDangerousLaunchArgs,
  launchDirectSession,
  launchRequiresDangerousApproval,
  listTmuxPanes,
  readControlCenterSnapshot,
  readLogExplorerSnapshot,
  readSidecarSnapshot,
  readTeamSnapshot,
  readWorkspaceSnapshot,
  redactOmxLogLine,
  runOmxCatalogCommand,
  runTeamApiForVscode,
  searchOmxLogs,
  sendTmuxPaneInput,
  type BuildDirectSessionArgsOptions,
  type CaptureTmuxPaneTailOptions,
  type ControlCenterTeamSnapshot,
  type LaunchDirectSessionOptions,
  type ListTmuxPanesOptions,
  type OmxControlCenterSnapshot,
  type OmxDirectSessionHandle,
  type OmxLogEntry,
  type OmxLogExplorerSnapshot,
  type OmxLogSearchFilters,
  type OmxTeamSnapshot,
  type OmxWorkspaceSnapshot,
  type ReadTeamSnapshotOptions,
  type ReadWorkspaceSnapshotOptions,
  type RunOmxCatalogCommandOptions,
  type RunOmxCatalogCommandResult,
  type SearchOmxLogsOptions,
  type SendTmuxPaneInputOptions,
  type TmuxPaneInputResult,
  type TmuxPaneRef,
  type TmuxPaneTail,
  type VscodeLogRef,
} from './vscode/index.js';
