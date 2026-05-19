// Re-exports para consumidores externos (Wave 3) não precisarem importar
// de 3 lugares diferentes.

export type { TagChipProps } from './TagChip';
export type { TagOption, TagPickerProps } from './TagPicker';
export type {
  TagFilterBuilderProps,
  TagFilterClause,
  TagFilterValue,
} from './TagFilterBuilder';
export type { WorkspaceTag } from './use-workspace-tags';
