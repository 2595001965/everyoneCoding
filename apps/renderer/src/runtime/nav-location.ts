import { create } from 'zustand';

export interface NavLocation {
  projectId: string;
  filePath?: string;
  line?: number;
  pageId?: string;
  elementId?: string;
}

export const useNavLocation = create<{ target: NavLocation | null }>(() => ({ target: null }));

export function navigateToLocation(target: NavLocation): void {
  useNavLocation.setState({ target });
  if (typeof window !== 'undefined')
    window.location.hash = target.filePath ? '#/code' : '#/designer';
}
