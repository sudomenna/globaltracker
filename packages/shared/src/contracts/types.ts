// General-purpose utility types shared across all modules.

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type ActorRef = {
  type: 'user' | 'system' | 'api_key';
  id: string;
  workspaceId?: string;
};

export type PaginationParams = {
  limit: number;
  offset: number;
};

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};
