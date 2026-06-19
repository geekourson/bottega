import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../utils/api';
import { useAuth } from './AuthContext';

export interface GitHubAuthContextValue {
  connected: boolean;
  username: string | null;
  isChecking: boolean;
  isStarting: boolean;
  deviceFlowActive: boolean;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  hasDeviceFlowConfig: boolean;
  error: string | null;
  startDeviceFlow: () => Promise<void>;
  cancelDeviceFlow: () => Promise<void>;
  saveToken: (token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const defaultContext: GitHubAuthContextValue = {
  connected: false,
  username: null,
  isChecking: false,
  isStarting: false,
  deviceFlowActive: false,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  hasDeviceFlowConfig: false,
  error: null,
  startDeviceFlow: async () => {},
  cancelDeviceFlow: async () => {},
  saveToken: async () => {},
  disconnect: async () => {},
  refreshStatus: async () => {},
};

const GitHubAuthContext = createContext<GitHubAuthContextValue>(defaultContext);

export function useGitHubAuth(): GitHubAuthContextValue {
  return useContext(GitHubAuthContext) || defaultContext;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function GitHubAuthProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const hasAuthUser = !!user;
  const authUserKey = user?.id ?? user?.username ?? null;

  const [connected, setConnected] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [deviceFlowActive, setDeviceFlowActive] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [hasDeviceFlowConfig, setHasDeviceFlowConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPollInterval = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (isAuthLoading || !hasAuthUser) return;

    setIsChecking(true);
    setError(null);

    try {
      const response = await api.githubAuth.status();
      const data = await readJson(response);

      if (!response.ok) {
        throw new Error((data.error as string) || 'Failed to check GitHub auth status');
      }

      setConnected(Boolean(data.connected));
      setUsername((data.username as string | null) ?? null);
      setHasDeviceFlowConfig(Boolean(data.hasDeviceFlowConfig));
      setDeviceFlowActive(Boolean(data.hasDeviceFlow));
      setUserCode((data.userCode as string | null) ?? null);
      setVerificationUri((data.verificationUri as string | null) ?? null);
      setExpiresAt((data.expiresAt as string | null) ?? null);

      // If we just became connected, stop polling
      if (Boolean(data.connected)) {
        clearPollInterval();
        setDeviceFlowActive(false);
        setUserCode(null);
        setVerificationUri(null);
        setExpiresAt(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsChecking(false);
    }
  }, [authUserKey, hasAuthUser, isAuthLoading, clearPollInterval]);

  // Poll status while device flow is active (every 3 seconds)
  useEffect(() => {
    if (deviceFlowActive) {
      clearPollInterval();
      const interval = setInterval(() => {
        void refreshStatus();
      }, 3000);
      pollIntervalRef.current = interval;
    } else {
      clearPollInterval();
    }
    return () => clearPollInterval();
  }, [deviceFlowActive, refreshStatus, clearPollInterval]);

  // Initial status check
  useEffect(() => {
    if (!isAuthLoading && hasAuthUser) {
      void refreshStatus();
    }
  }, [authUserKey, hasAuthUser, isAuthLoading, refreshStatus]);

  const startDeviceFlow = useCallback(async (): Promise<void> => {
    setIsStarting(true);
    setError(null);
    try {
      const response = await api.githubAuth.startDeviceFlow();
      const data = await readJson(response);

      if (!response.ok) {
        throw new Error((data.error as string) || 'Failed to start GitHub device flow');
      }

      setUserCode((data.userCode as string) ?? null);
      setVerificationUri((data.verificationUri as string) ?? null);
      setExpiresAt((data.expiresAt as string) ?? null);
      setDeviceFlowActive(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsStarting(false);
    }
  }, []);

  const cancelDeviceFlow = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await api.githubAuth.cancelDeviceFlow();
      setDeviceFlowActive(false);
      setUserCode(null);
      setVerificationUri(null);
      setExpiresAt(null);
      clearPollInterval();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, [clearPollInterval]);

  const saveToken = useCallback(async (token: string): Promise<void> => {
    setError(null);
    try {
      const response = await api.githubAuth.saveToken(token);
      const data = await readJson(response);

      if (!response.ok) {
        throw new Error((data.error as string) || 'Failed to save GitHub token');
      }

      await refreshStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, [refreshStatus]);

  const disconnect = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.githubAuth.disconnect();
      const data = await readJson(response);

      if (!response.ok) {
        throw new Error((data.error as string) || 'Failed to disconnect GitHub');
      }

      setConnected(false);
      setUsername(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, []);

  const value = useMemo<GitHubAuthContextValue>(
    () => ({
      connected,
      username,
      isChecking,
      isStarting,
      deviceFlowActive,
      userCode,
      verificationUri,
      expiresAt,
      hasDeviceFlowConfig,
      error,
      startDeviceFlow,
      cancelDeviceFlow,
      saveToken,
      disconnect,
      refreshStatus,
    }),
    [
      connected,
      username,
      isChecking,
      isStarting,
      deviceFlowActive,
      userCode,
      verificationUri,
      expiresAt,
      hasDeviceFlowConfig,
      error,
      startDeviceFlow,
      cancelDeviceFlow,
      saveToken,
      disconnect,
      refreshStatus,
    ],
  );

  return <GitHubAuthContext.Provider value={value}>{children}</GitHubAuthContext.Provider>;
}
