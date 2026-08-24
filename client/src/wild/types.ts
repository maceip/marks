import type { CommandId, CommandReceipt, CommandRisk, CommandSource } from '../commands/types.ts';
import type { SourceRange } from '../intelligence/types.ts';

export type WildCapability =
  | 'intent'
  | 'causal'
  | 'consequences'
  | 'half-life'
  | 'counterfactuals';

export type ConsequenceLaneId =
  | 'source'
  | 'render'
  | 'collaboration'
  | 'durability'
  | 'external';

export type ConsequenceImpact = 'none' | 'observe' | 'change' | 'boundary';

export interface ConsequenceLane {
  id: ConsequenceLaneId;
  label: string;
  impact: ConsequenceImpact;
  detail: string;
}

export interface IntentCandidate {
  id: string;
  label: string;
  detail: string;
  commandIds: CommandId[];
  basis: 'document' | 'activity' | 'declared';
  confidence: number;
  urgency: 'now' | 'next' | 'later';
}

export interface StoredIntent extends IntentCandidate {
  documentId: string;
  createdAt: number;
  updatedAt: number;
  state: 'pinned' | 'done' | 'dismissed';
}

export interface SourceDelta {
  from: number;
  beforeChars: number;
  afterChars: number;
  beforeLines: number;
  afterLines: number;
}

export interface CausalReceipt {
  id: string;
  documentId: string;
  commandId: CommandId;
  commandLabel: string;
  source: CommandSource;
  risk: CommandRisk;
  status: CommandReceipt['status'];
  proposedAt: number;
  startedAt: number | null;
  finishedAt: number;
  beforeDigest: string;
  afterDigest: string;
  beforeChars: number;
  afterChars: number;
  selectionFrom: number;
  selectionTo: number;
  modeBefore: string;
  sourceDelta: SourceDelta | null;
  lanes: ConsequenceLane[];
  counterfactualId: string | null;
  message: string | null;
  error: string | null;
}

export type ContextSignalKind =
  | 'relative-time'
  | 'as-of-date'
  | 'version-claim'
  | 'deadline'
  | 'external-dependency'
  | 'explicit';

export interface ContextSignal {
  id: string;
  documentId: string;
  kind: ContextSignalKind;
  label: string;
  detail: string;
  expected: string;
  range: SourceRange;
  firstSeenAt: number;
  lastSeenAt: number;
  reviewedAt: number | null;
  ttlMs: number;
  active: boolean;
  dismissed: boolean;
}

export interface CounterfactualPatch {
  id: string;
  documentId: string;
  label: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  source: 'human' | 'agent' | 'command';
  commandId: CommandId | null;
  baseDigest: string;
  from: number;
  expected: string;
  replacement: string;
  prefix: string;
  suffix: string;
  archived: boolean;
  appliedAt: number | null;
}

export interface CommandEffectObservation {
  phase: 'started' | 'finished';
  runId: string;
  documentId: string;
  commandId: CommandId;
  commandLabel: string;
  source: CommandSource;
  risk: CommandRisk;
  proposedAt: number;
  startedAt: number;
  finishedAt?: number;
  status?: CommandReceipt['status'];
  message?: string;
  error?: string;
  beforeText: string;
  afterText?: string;
  selectionFrom: number;
  selectionTo: number;
  modeBefore: string;
}
