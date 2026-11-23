import { AccountType } from './statement';

export type ReconTargetType = 'Expense' | 'Income';

export type ReconLinkMode = 'Auto' | 'Manual';

export type ReconCardinality = 'none' | '1:1' | '1:N' | 'N:1' | 'M:N';

export type AllocationStatus = 'unlinked' | 'partial' | 'full';

export interface ReconLink {
  /** Unique primary key inside the Recon_Links tab (e.g. LNK-...) */
  linkId: string;
  /** 1-based row number in the Recon_Links Google Sheet tab, or null if virtual/legacy/unsaved */
  sheetRowNumber: number | null;
  /** Which Bank Statement tab owns Bank_Unique_ID */
  bankTab: AccountType;
  /** Unique_ID from Bank_Ledger (Puja or Regular) */
  bankUniqueId: string;
  /** Target ledger type ('Expense' now; 'Income' ready for future Income_Ledger) */
  targetType: ReconTargetType;
  /** Linked Exp_ID (or future Inc_ID) */
  targetId: string;
  /** Dollar amount allocated from this bank transaction to this target record */
  allocatedAmount: number;
  /** Integer cents representation of allocatedAmount to avoid floating-point drift */
  allocatedCents: number;
  /** Category of the allocated amount (copied from Expense/Income record) */
  category: string;
  /** Whether this link was created via Auto-Match or Manual linking */
  linkMode: ReconLinkMode;
  /** ISO timestamp of when the link was created */
  linkedAt: string;
  /** Optional reconciliation note */
  notes: string;
}

export interface NewReconLinkInput {
  linkId?: string;
  bankTab: AccountType;
  bankUniqueId: string;
  targetType: ReconTargetType;
  targetId: string;
  allocatedAmount: number;
  category: string;
  linkMode?: ReconLinkMode;
  linkedAt?: string;
  notes?: string;
}

export interface AllocationSummary {
  totalAmount: number;
  totalCents: number;
  allocatedAmount: number;
  allocatedCents: number;
  remainingAmount: number;
  remainingCents: number;
  links: ReconLink[];
  partnerIds: string[];
  distinctCategories: string[];
  matchCardinality: ReconCardinality;
  status: AllocationStatus;
  derivedIsRecon: 'Yes' | 'No';
  /** Single shared category, or 'Multiple' if links span 2+ distinct categories */
  derivedCategory: string | undefined;
}

export interface LoadedReconLinks {
  spreadsheetId: string;
  tabName: string;
  tabExists: boolean;
  hasHeader: boolean;
  links: ReconLink[];
  existingLinkIds: Set<string>;
}
