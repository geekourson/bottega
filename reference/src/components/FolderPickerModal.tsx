import { useState, useEffect, useCallback } from 'react';
import { X, Folder, ChevronRight, ArrowLeft, Home } from 'lucide-react';
import { Button } from './ui/button';
import { authenticatedFetch } from '../utils/api';

interface FolderEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  current: string;
  parent: string | null;
  entries: FolderEntry[];
}

export interface FolderPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

function FolderPickerModal({ isOpen, onClose, onSelect, initialPath }: FolderPickerModalProps) {
  const [current, setCurrent] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = targetPath
        ? `/api/filesystem/browse?path=${encodeURIComponent(targetPath)}`
        : '/api/filesystem/browse';
      const res = await authenticatedFetch<BrowseResponse>(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? 'Impossible de lire le dossier');
        return;
      }
      const data = (await res.json()) as BrowseResponse;
      setCurrent(data.current);
      setParent(data.parent);
      setEntries(data.entries);
    } catch {
      setError('Erreur réseau');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      browse(initialPath || undefined);
    }
  }, [isOpen, initialPath, browse]);

  if (!isOpen) return null;

  const pathParts = current.split('/').filter(Boolean);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">Choisir un dossier</h2>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-muted/40 shrink-0 overflow-x-auto">
          <button
            onClick={() => browse('/')}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          {pathParts.map((part, i) => {
            const partPath = '/' + pathParts.slice(0, i + 1).join('/');
            return (
              <span key={partPath} className="flex items-center gap-1 shrink-0">
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
                <button
                  onClick={() => browse(partPath)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Chargement…
            </div>
          )}

          {error && !loading && (
            <div className="p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
          )}

          {!loading && !error && (
            <>
              {parent && (
                <button
                  onClick={() => browse(parent)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 shrink-0" />
                  <span>..</span>
                </button>
              )}

              {entries.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-6">Dossier vide</p>
              )}

              {entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => browse(entry.path)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
                >
                  <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                  <span className="text-left truncate">{entry.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-border shrink-0">
          <p className="text-xs text-muted-foreground truncate flex-1">{current}</p>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={onClose}>
              Annuler
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                onSelect(current);
                onClose();
              }}
              disabled={!current}
            >
              Sélectionner
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default FolderPickerModal;
