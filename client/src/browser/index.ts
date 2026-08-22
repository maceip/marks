export { markdownFromClipboard, writeClipboard, writeClipboardEvent, readClipboardMarkdown, readClipboardText, isPlainUrl } from './clipboard.ts';
export { htmlToMarkdown, htmlLooksRich, decodeEntities } from './html-to-markdown.ts';
export {
  shouldOfferCustomMenu,
  surfaceFromTarget,
  hasDomSelection,
  clampMenuPosition,
  createLongPress,
  LONG_PRESS_MS,
  type ContextMenuRequest,
  type ContextSurface,
} from './context-menu.ts';
export { surfaceForEvent, selectElementContents, shouldHandleSelectAll, previewHasSelection, type Surface } from './select-all.ts';
export { VoiceSession, type VoiceStatus, type VoiceTranscript } from './voice.ts';
export {
  COMMENTS_MAP,
  COMMENT_ORIGIN,
  createCommentId,
  parseComment,
  serializeComment,
  readCommentMap,
  resolveCommentRange,
  encodeBytes,
  decodeBytes,
  openComments,
  type CommentRecord,
} from './comments.ts';
export { TabChannel, tabChannelName, createTabId } from './tab-sync.ts';
export { withPersistLock, writeSnapshotUnderLock, persistLockName } from './persist-lock.ts';
export { documentIsOpenable } from './document-support.ts';
export {
  readNetworkQuality,
  snapshotFetchTimeoutMs,
  subscribeNetwork,
  fetchWithTimeout,
  type NetworkQuality,
} from './network.ts';
export { readCatalog, writeCatalog, readDocumentMeta, writeDocumentMeta, forgetDocumentMeta } from './catalog-cache.ts';
export { registerServiceWorker } from './service-worker.ts';
export {
  isCoarsePointer,
  isApple,
  modifierLabel,
  speechRecognitionCtor,
  isAutomatedBrowser,
  pageIsVisible,
} from './platform.ts';
