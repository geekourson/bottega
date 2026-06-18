import React, { useState, useEffect, useRef } from 'react';
import { X, BrainCircuit } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

export interface PoSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (instructions: string) => void;
  projectName?: string;
  isSubmitting?: boolean;
}

function PoSessionModal({
  isOpen,
  onClose,
  onSubmit,
  projectName,
  isSubmitting = false,
}: PoSessionModalProps) {
  const [instructions, setInstructions] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setInstructions('');
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit(instructions.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !isSubmitting) onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={!isSubmitting ? onClose : undefined}
      />

      <div
        className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-md mx-4"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">Session PO</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {projectName && (
            <div className="text-sm text-muted-foreground">
              Projet :{' '}
              <span className="font-medium text-foreground">{projectName}</span>
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="po-session-instructions"
              className="text-sm font-medium text-foreground"
            >
              Instructions <span className="text-muted-foreground font-normal">(optionnel)</span>
            </label>
            <Textarea
              ref={textareaRef}
              id="po-session-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Ex : se concentrer sur l'accessibilité, ignorer la refonte du backend, prioriser les bugs utilisateurs…"
              rows={4}
              disabled={isSubmitting}
              className="resize-y min-h-[90px]"
            />
            <p className="text-xs text-muted-foreground">
              Laissez vide pour laisser l'agent explorer librement le projet.
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Annuler
            </Button>
            <Button
              type="submit"
              variant="default"
              className="flex-1"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Démarrage…
                </>
              ) : (
                'Démarrer la session'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default PoSessionModal;
