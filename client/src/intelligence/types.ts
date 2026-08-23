export type PracticalCapability =
  | 'health'
  | 'render'
  | 'accessibility'
  | 'schema'
  | 'publish'
  | 'links'
  | 'citations'
  | 'structure'
  | 'collaboration'
  | 'recovery'
  | 'versions'
  | 'assets'
  | 'reader'
  | 'privacy'
  | 'ledger'
  | 'paste'
  | 'blocks'
  | 'quality';

export type FindingSeverity = 'error' | 'warning' | 'suggestion' | 'info';

/** JavaScript string offsets are UTF-16, matching CodeMirror and ESBT. */
export interface SourceRange {
  from: number;
  to: number;
  line: number;
  column: number;
}

export interface SourceFix {
  label: string;
  from: number;
  to: number;
  expected: string;
  replacement: string;
}

export interface IntelligenceFinding {
  id: string;
  capability: PracticalCapability;
  severity: FindingSeverity;
  code: string;
  title: string;
  detail: string;
  range?: SourceRange;
  fix?: SourceFix;
}

export interface IntelligenceHeading {
  level: number;
  text: string;
  slug: string;
  range: SourceRange;
  sectionFrom: number;
  sectionTo: number;
}

export type LinkKind = 'anchor' | 'document' | 'external' | 'email' | 'relative' | 'asset';

export interface IntelligenceLink {
  id: string;
  label: string;
  destination: string;
  kind: LinkKind;
  range: SourceRange;
  destinationRange: SourceRange;
  status: 'valid' | 'broken' | 'unchecked';
  statusDetail: string;
}

export interface IntelligenceImage extends IntelligenceLink {
  alt: string;
  localAssetId: string | null;
}

export interface IntelligenceCitation {
  id: string;
  key: string;
  style: 'pandoc' | 'footnote' | 'doi';
  range: SourceRange;
  defined: boolean;
  definitionRange?: SourceRange;
}

export interface IntelligenceTask {
  id: string;
  text: string;
  checked: boolean;
  range: SourceRange;
  markerRange: SourceRange;
  owner: string | null;
  due: string | null;
}

export interface IntelligenceDecision {
  id: string;
  text: string;
  range: SourceRange;
}

export interface IntelligenceBlockReference {
  id: string;
  documentId: string;
  heading: string | null;
  label: string | null;
  range: SourceRange;
}

export interface IntelligenceFrontMatter {
  exists: boolean;
  range: SourceRange | null;
  bodyFrom: number;
  valid: boolean;
  errors: string[];
  value: Record<string, unknown>;
  known: {
    title: string;
    description: string;
    audience: string;
    status: string;
    tags: string[];
    publishProfile: 'web' | 'print' | 'readme' | 'slides';
    canonicalUrl: string;
    draft: boolean;
    privacyMode: 'standard' | 'strict';
    readingGrade: number;
    maxSentenceWords: number;
  };
}

export interface ReaderMetrics {
  words: number;
  sentences: number;
  paragraphs: number;
  readingMinutes: number;
  speakingMinutes: number;
  averageSentenceWords: number;
  fleschReadingEase: number;
  estimatedGrade: number;
}

export interface IntelligenceStats {
  chars: number;
  bytes: number;
  lines: number;
  headings: number;
  links: number;
  images: number;
  citations: number;
  tasks: number;
  completedTasks: number;
  decisions: number;
  blockReferences: number;
}

export interface DocumentIntelligence {
  revision: number;
  truncated: boolean;
  healthScore: number;
  stats: IntelligenceStats;
  reader: ReaderMetrics;
  frontMatter: IntelligenceFrontMatter;
  headings: IntelligenceHeading[];
  links: IntelligenceLink[];
  images: IntelligenceImage[];
  citations: IntelligenceCitation[];
  tasks: IntelligenceTask[];
  decisions: IntelligenceDecision[];
  blockReferences: IntelligenceBlockReference[];
  findings: IntelligenceFinding[];
}

export interface IntelligenceAnalyzeRequest {
  type: 'analyze';
  revision: number;
  text: string;
}

export interface IntelligenceAnalyzeResponse {
  type: 'analyzed';
  revision: number;
  analysis: DocumentIntelligence;
}
