import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { cn } from '../lib/utils';

interface InlineRenameFieldProps {
  /** Editable part of the value. */
  value: string;
  /** Rendered in place of `value` when not editing. */
  display?: React.ReactNode;
  /** Persist the new value; resolve to an error message to keep editing. */
  onSave: (next: string) => Promise<string | null>;
  editTitle: string;
  /** Let an empty value be saved (clears it) instead of cancelling. */
  allowEmpty?: boolean;
  className?: string;
  inputClassName?: string;
}

export default function InlineRenameField({
  value,
  display,
  onSave,
  editTitle,
  allowEmpty = false,
  className,
  inputClassName,
}: InlineRenameFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  const startEditing = () => {
    setDraft(value);
    setError(null);
    setIsEditing(true);
  };

  const cancel = () => {
    setIsEditing(false);
    setError(null);
  };

  const save = async () => {
    const next = draft.trim();
    if ((!next && !allowEmpty) || next === value) {
      cancel();
      return;
    }
    setIsSaving(true);
    setError(null);
    const saveError = await onSave(next);
    setIsSaving(false);
    if (saveError) {
      setError(saveError);
    } else {
      setIsEditing(false);
    }
  };

  if (!isEditing) {
    return (
      <div className={cn('flex items-center gap-1 min-w-0', className)}>
        {display ?? (
          <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded truncate">
            {value}
          </span>
        )}
        <button
          type="button"
          onClick={startEditing}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted flex-shrink-0"
          title={editTitle}
          aria-label={editTitle}
        >
          <Pencil className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1 min-w-0', className)}>
      <div className="flex items-center gap-1 min-w-0">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
          disabled={isSaving}
          className={cn(
            'h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring',
            inputClassName,
          )}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={isSaving}
          className="p-1 rounded text-green-600 hover:bg-muted flex-shrink-0"
          title="Enregistrer"
          aria-label="Enregistrer"
        >
          {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={isSaving}
          className="p-1 rounded text-muted-foreground hover:bg-muted flex-shrink-0"
          title="Annuler"
          aria-label="Annuler"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {error && <span className="text-xs text-red-600 dark:text-red-400 break-words">{error}</span>}
    </div>
  );
}
