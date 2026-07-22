import { createContext, useContext } from 'react';

export type Role = 'admin' | 'editor' | 'viewer';
export interface Me { username: string; role: Role; twoFactor: boolean }

export const MeContext = createContext<Me>({ username: '', role: 'viewer', twoFactor: false });
export const useMe = () => useContext(MeContext);

/** True when the current user may make changes (editor or admin). */
export const canWrite = (role: Role) => role === 'admin' || role === 'editor';
