'use client';
import { createContext, useContext } from 'react';

interface WorkspaceContextValue {
  workspaceId: string | null;
}

export const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaceId: null,
});

export const useWorkspace = () => useContext(WorkspaceContext);
