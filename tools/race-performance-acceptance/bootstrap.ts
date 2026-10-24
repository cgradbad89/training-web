import { installRuntimeGuard } from './runtimeGuard';
export const guard = installRuntimeGuard();
const { mountAcceptance } = await import('./main');
mountAcceptance(guard);
