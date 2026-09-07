// User-defined inbox filter rules: "if an incoming email matches these
// conditions, apply these actions". Framework-agnostic types shared by the
// evaluation helper (utils/filters), the storage layer, and the UI.

export type FilterField = 'from' | 'to' | 'cc' | 'subject' | 'body' | 'domain';

export type FilterOperator = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith';

export interface FilterCondition {
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export type FilterActionType =
  | 'markRead'
  | 'star'
  | 'archive'
  | 'delete'
  | 'moveToSpam'
  | 'moveToFolder'
  | 'applyLabel';

export interface FilterAction {
  type: FilterActionType;
  /** Target for moveToFolder (folder path) and applyLabel (label name). */
  value?: string;
}

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Higher runs first. Ties fall back to creation order. */
  priority: number;
  /** 'all' = every condition must match (AND); 'any' = at least one (OR). */
  matchType: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  /** When true, no lower-priority rule runs after this one matches. */
  stopProcessing: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Shape accepted when creating/updating a rule (server fills id/timestamps). */
export interface FilterRuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  matchType?: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  stopProcessing?: boolean;
}
