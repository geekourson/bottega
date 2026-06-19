import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Github,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useGitHubAuth } from '../contexts/GitHubAuthContext';
import { Button } from './ui/button';

export function GitHubAuthPanel() {
  const {
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
  } = useGitHubAuth();

  const [patInput, setPatInput] = useState('');
  const [isSavingPat, setIsSavingPat] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const loading = isChecking && !connected && !deviceFlowActive;

  const expiryText = (() => {
    if (!expiresAt) return null;
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) return null;
    return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  })();

  const handleSavePat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!patInput.trim()) return;
    setIsSavingPat(true);
    setInfo(null);
    await saveToken(patInput.trim());
    setPatInput('');
    setInfo('Token saved.');
    setIsSavingPat(false);
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    setInfo(null);
    await disconnect();
    setInfo('GitHub token removed.');
    setIsDisconnecting(false);
  };

  return (
    <div className="space-y-4" data-testid="github-auth-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Github className="w-5 h-5" /> GitHub
        </h3>
        <p className="text-sm text-muted-foreground">
          Connect GitHub so Bottega can run{' '}
          <code className="text-xs">gh</code> commands (create PRs, check CI, merge).
          Token stored at{' '}
          <code className="text-xs">~/.config/bottega/users/&lt;id&gt;/github_token</code>.
        </p>
      </div>

      {/* Status badge */}
      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </>
          ) : connected ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">Connected</span>
              {username && (
                <span className="text-muted-foreground">— @{username}</span>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-amber-600" />
              <span>Not connected</span>
            </>
          )}
        </div>

        {connected && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            disabled={isDisconnecting}
            data-testid="github-auth-disconnect"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Disconnect
          </Button>
        )}
      </div>

      {/* Device flow — shown when GITHUB_OAUTH_CLIENT_ID is set */}
      {!connected && hasDeviceFlowConfig && (
        <div className="space-y-3">
          {!deviceFlowActive ? (
            <Button
              onClick={() => void startDeviceFlow()}
              disabled={isStarting}
              data-testid="github-auth-start"
            >
              {isStarting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Connect GitHub
            </Button>
          ) : (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4 space-y-3">
              <div className="text-sm font-medium">
                Enter this code on GitHub to authorize Bottega:
              </div>
              {userCode && (
                <div className="font-mono text-2xl font-bold tracking-widest text-center py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded">
                  {userCode}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {verificationUri && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.open(verificationUri, '_blank', 'noopener,noreferrer')
                    }
                    data-testid="github-auth-open"
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Open GitHub
                  </Button>
                )}
                {userCode && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(userCode);
                      setInfo('Code copied to clipboard');
                    }}
                  >
                    <Copy className="w-3 h-3 mr-1" />
                    Copy code
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void cancelDeviceFlow()}
                  data-testid="github-auth-cancel"
                >
                  Cancel
                </Button>
              </div>
              {expiryText && (
                <p className="text-xs text-muted-foreground">
                  Code expires around {expiryText}. Waiting for authorization…
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* PAT fallback — shown when GITHUB_OAUTH_CLIENT_ID is NOT set */}
      {!connected && !hasDeviceFlowConfig && (
        <div className="space-y-3 bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">
            To use the OAuth Device Flow, set{' '}
            <code className="text-xs font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">
              GITHUB_OAUTH_CLIENT_ID
            </code>{' '}
            in your <code className="text-xs">.env</code>. Otherwise, paste a Personal
            Access Token (PAT) below.
          </p>
          <p className="text-sm">
            <a
              href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Bottega"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-1"
            >
              Create a PAT on GitHub <ExternalLink className="w-3 h-3" />
            </a>{' '}
            with <code className="text-xs">repo</code> and{' '}
            <code className="text-xs">read:org</code> scopes.
          </p>
          <form onSubmit={handleSavePat} className="space-y-2">
            <input
              type="password"
              value={patInput}
              onChange={(e) => setPatInput(e.target.value)}
              placeholder="ghp_…"
              disabled={isSavingPat}
              data-testid="github-auth-pat-input"
              className="w-full font-mono text-sm bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Button
              type="submit"
              disabled={!patInput.trim() || isSavingPat}
              data-testid="github-auth-pat-save"
            >
              {isSavingPat ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Save token
            </Button>
          </form>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {info && !error && (
        <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300">
          {info}
        </div>
      )}
    </div>
  );
}

export default GitHubAuthPanel;
