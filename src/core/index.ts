/**
 * Transport-neutral public API for agent-coop.
 *
 * MCP, CLI and future HTTP adapters must depend on this module instead of
 * reaching into transport implementations. The current function names are
 * kept for backwards compatibility while the domain operations are migrated
 * behind this boundary.
 */
export { coopInit, type InitInput } from "../tools/init.js";
export { coopSync, type SyncInput } from "../tools/sync.js";
export { coopConfigureMemory } from "../tools/configure.js";
export { coopGetGlobalState, type GlobalStateInput } from "../tools/global-state.js";
export { coopPublishState } from "../tools/publish-state.js";
export { coopReconcile, type ReconcileInput } from "../tools/reconcile.js";
export {
  coopPostTask,
  coopClaimTask,
  coopUpdateTask,
  coopGetTask,
  coopLogMilestone,
  coopRecommendAgents,
  coopListTasks,
  coopSendMessage,
  coopAcknowledgeMessage,
  coopReadMessages,
  coopCheckInbox,
  type SendMessageInput,
  type MessageReceiptStatus,
} from "../tools/coop.js";
export {
  type TaskStatus,
  type TaskPriority,
  type MessageKind,
  type MessagePriority,
  MESSAGE_KINDS,
  MESSAGE_PRIORITIES,
} from "../schema/coop.js";
export { createCoopContext, resolveCoopRoot, type CoopContext } from "../context.js";
