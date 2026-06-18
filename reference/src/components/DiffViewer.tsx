import { useState } from 'react';
import { ChevronDown, ChevronRight, FilePlus, FileMinus, FileEdit, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      current = {
        oldPath: '',
        newPath: '',
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      currentHunk = null;
    } else if (line.startsWith('new file mode')) {
      if (current) current.isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      if (current) current.isDeleted = true;
    } else if (line.startsWith('--- ')) {
      if (current) {
        const p = line.slice(4);
        current.oldPath = p === '/dev/null' ? '/dev/null' : p.replace(/^a\//, '');
        if (p === '/dev/null') current.isNew = true;
      }
    } else if (line.startsWith('+++ ')) {
      if (current) {
        const p = line.slice(4);
        current.newPath = p === '/dev/null' ? '/dev/null' : p.replace(/^b\//, '');
        if (p === '/dev/null') current.isDeleted = true;
      }
    } else if (line.startsWith('@@ ')) {
      if (current) {
        currentHunk = { header: line, lines: [] };
        current.hunks.push(currentHunk);
      }
    } else if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        if (current) current.additions++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', content: line.slice(1) });
        if (current) current.deletions++;
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', content: line.slice(1) });
      }
    }
  }

  if (current) files.push(current);
  return files.filter(f => f.hunks.length > 0 || f.isNew || f.isDeleted);
}

function FileDiff({ file }: { file: DiffFile }) {
  const [expanded, setExpanded] = useState(true);
  const displayPath = file.isDeleted ? file.oldPath : file.newPath;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/50 hover:bg-muted transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}

        {file.isNew ? (
          <FilePlus className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
        ) : file.isDeleted ? (
          <FileMinus className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
        ) : (
          <FileEdit className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
        )}

        <span className="text-xs font-mono text-foreground truncate flex-1">{displayPath}</span>

        <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono">
          {file.additions > 0 && (
            <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="overflow-x-auto">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="px-3 py-1 text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-t border-border">
                {hunk.header}
              </div>
              <table className="w-full border-collapse text-xs font-mono">
                <tbody>
                  {hunk.lines.map((line, li) => (
                    <tr
                      key={li}
                      className={cn(
                        line.type === 'add' && 'bg-green-50 dark:bg-green-900/20',
                        line.type === 'remove' && 'bg-red-50 dark:bg-red-900/20',
                      )}
                    >
                      <td className="w-4 select-none px-2 text-muted-foreground text-right border-r border-border">
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </td>
                      <td className="px-3 py-0.5 whitespace-pre text-foreground">
                        {line.content}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DiffViewerProps {
  diff: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function DiffViewer({ diff, isLoading, error, onRefresh }: DiffViewerProps) {
  const files = diff ? parseDiff(diff) : [];
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
        <span className="text-xs text-muted-foreground">
          {isLoading ? 'Chargement...' : diff === null ? '' : files.length === 0
            ? 'Aucun changement'
            : `${files.length} fichier${files.length > 1 ? 's' : ''} modifié${files.length > 1 ? 's' : ''} · `}
          {!isLoading && files.length > 0 && (
            <>
              <span className="text-green-600 dark:text-green-400">+{totalAdditions}</span>
              {' '}
              <span className="text-red-600 dark:text-red-400">-{totalDeletions}</span>
            </>
          )}
        </span>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50"
          title="Rafraîchir"
        >
          <RefreshCw className={cn('w-3.5 h-3.5 text-muted-foreground', isLoading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
            {error}
          </div>
        )}

        {!isLoading && !error && diff !== null && files.length === 0 && (
          <div className="text-sm text-muted-foreground text-center py-8">
            Aucun changement par rapport à la branche principale.
          </div>
        )}

        {!isLoading && diff === null && !error && (
          <div className="text-sm text-muted-foreground text-center py-8">
            Cliquez sur Rafraîchir pour voir les changements.
          </div>
        )}

        {files.map((file, i) => (
          <FileDiff key={i} file={file} />
        ))}
      </div>
    </div>
  );
}
