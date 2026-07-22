import { createContext, useContext } from 'react';

export type Role = 'admin' | 'editor' | 'viewer';
export interface Me { email: string | null; username: string; needsEmailClaim: boolean; role: Role; twoFactor: boolean }

export const MeContext = createContext<Me>({ email: null, username: '', needsEmailClaim: false, role: 'viewer', twoFactor: false });
export const useMe = () => useContext(MeContext);

/** True when the current user may make changes (editor or admin). */
export const canWrite = (role: Role) => role === 'admin' || role === 'editor';
