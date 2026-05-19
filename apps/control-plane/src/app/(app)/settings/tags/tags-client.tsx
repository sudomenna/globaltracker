'use client';

/**
 * Settings → Tags (T-TAGS-006)
 *
 * Catálogo de workspace_tags. CRUD completo:
 *   - GET    /v1/workspace-tags?include_archived&with_count
 *   - POST   /v1/workspace-tags             {name, color?, description?}
 *   - PATCH  /v1/workspace-tags/:id         {name?, color?, description?}
 *   - DELETE /v1/workspace-tags/:id         {cascade?: boolean}
 *   - POST   /v1/workspace-tags/:id/unarchive
 *
 * Componentes reutilizados:
 *   - TagChip — preview de cor consistente com o resto do app
 *   - useWorkspaceTags — fetcher canônico (com_count + include_archived)
 *
 * Toda mutação é feita via fetch direto (não há mutação no hook); ao final
 * chamamos `reload()` para reposicionar a lista. É barato (uma tag table
 * raramente passa de algumas centenas de linhas) e elimina a complexidade
 * de optimistic update + rollback.
 */

import { TagChip } from '@/components/tags/TagChip';
import {
  useWorkspaceTags,
  type WorkspaceTag,
} from '@/components/tags/use-workspace-tags';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Archive,
  ArchiveRestore,
  Loader2,
  Pencil,
  Plus,
  Search,
  Tags as TagsIcon,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const EDGE = process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

// ─── Auth ────────────────────────────────────────────────────────────────────

function readAccessToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
  if (!match) return '';
  try {
    let raw = match[1];
    if (raw?.startsWith('base64-')) {
      raw = atob(raw.slice(7));
    } else if (raw) {
      raw = decodeURIComponent(raw);
    }
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed?.access_token ?? '';
  } catch {
    return '';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}

function shortenActor(actor: string): string {
  // Audit format: `user:<uuid>` or `user:dev`. Show só o sufixo amigável.
  if (actor.startsWith('user:')) {
    const rest = actor.slice(5);
    if (rest === 'dev') return 'dev';
    return `${rest.slice(0, 6)}…`;
  }
  return actor;
}

// ─── Form sheet (create + edit) ──────────────────────────────────────────────

interface TagFormState {
  name: string;
  color: string;
  description: string;
}

const EMPTY_FORM: TagFormState = { name: '', color: '', description: '' };

function TagFormSheet({
  open,
  onClose,
  initial,
  onSubmit,
  saving,
  error,
}: {
  open: boolean;
  onClose: () => void;
  initial: TagFormState;
  onSubmit: (data: TagFormState) => Promise<void> | void;
  saving: boolean;
  error: string | null;
}) {
  const [form, setForm] = useState<TagFormState>(initial);

  // Reset form whenever the sheet opens. (We don't want stale state from a
  // previous edit leaking into a fresh "new tag" click.)
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const trimmedName = form.name.trim();
  const colorTouched = form.color.trim().length > 0;
  const colorInvalid = colorTouched && !isValidHex(form.color.trim());
  const canSubmit = trimmedName.length > 0 && !colorInvalid && !saving;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent aria-label="Formulário de tag">
        <SheetHeader onClose={onClose}>
          <SheetTitle>{initial.name ? 'Editar tag' : 'Nova tag'}</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) void onSubmit(form);
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tag-name" className="text-xs font-medium">
                Nome
              </label>
              <input
                id="tag-name"
                type="text"
                value={form.name}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ex.: VIP, frio, recuperação"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                required
              />
              <p className="text-[11px] text-muted-foreground">
                Até 120 caracteres. Duplicidade (case-insensitive) é bloqueada.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="tag-color" className="text-xs font-medium">
                Cor (opcional)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="tag-color"
                  type="text"
                  value={form.color}
                  placeholder="#22c55e"
                  maxLength={32}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  className="flex h-9 w-32 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 font-mono"
                />
                <TagChip
                  name={trimmedName || 'Pré-visualização'}
                  color={isValidHex(form.color.trim()) ? form.color.trim() : null}
                />
              </div>
              {colorInvalid && (
                <p className="text-[11px] text-destructive">
                  Use formato hexadecimal #RRGGBB (ex.: #22c55e).
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="tag-desc" className="text-xs font-medium">
                Descrição (opcional)
              </label>
              <textarea
                id="tag-desc"
                value={form.description}
                maxLength={500}
                rows={3}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Quando usar essa tag? Quem aplica?"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              />
              <p className="text-[11px] text-muted-foreground">
                Até 500 caracteres.
              </p>
            </div>

            {error && (
              <p className="text-xs text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />}
                Salvar
              </Button>
            </div>
          </form>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TagsClient() {
  const [showArchived, setShowArchived] = useState(false);
  const { tags, loading, error: loadError, reload } = useWorkspaceTags({
    includeArchived: showArchived,
    withCount: true,
  });

  // Search (client-side, debounced — we already have all rows in memory).
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQ(q.trim().toLowerCase()), 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [q]);

  const filtered = useMemo(() => {
    if (!debouncedQ) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(debouncedQ));
  }, [tags, debouncedQ]);

  // Form (create / edit) state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceTag | null>(null);
  const [formInitial, setFormInitial] = useState<TagFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setFormInitial(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(tag: WorkspaceTag) {
    setEditing(tag);
    setFormInitial({
      name: tag.name,
      color: tag.color ?? '',
      description: tag.description ?? '',
    });
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setFormError(null);
  }

  // Auto-dismiss feedback after a few seconds
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  async function submitForm(data: TagFormState) {
    const token = readAccessToken();
    if (!token) {
      setFormError('Sessão expirada. Faça login novamente.');
      return;
    }

    const payload: Record<string, unknown> = { name: data.name.trim() };
    const colorTrim = data.color.trim();
    if (colorTrim) payload.color = colorTrim;
    else if (editing) payload.color = null; // limpar cor explicitamente

    const descTrim = data.description.trim();
    if (descTrim) payload.description = descTrim;
    else if (editing) payload.description = null;

    setSaving(true);
    setFormError(null);
    try {
      const url = editing
        ? `${EDGE}/v1/workspace-tags/${editing.id}`
        : `${EDGE}/v1/workspace-tags`;
      const method = editing ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (res.status === 409) {
          setFormError('Já existe uma tag com esse nome.');
        } else if (res.status === 400) {
          const body = (await res.json().catch(() => ({}))) as {
            details?: Record<string, string[]>;
          };
          const firstDetail = body.details
            ? Object.values(body.details).flat()[0]
            : null;
          setFormError(firstDetail ?? 'Dados inválidos.');
        } else if (res.status === 401) {
          setFormError('Sessão expirada.');
        } else {
          setFormError(`Falha ao salvar (HTTP ${res.status}).`);
        }
        return;
      }
      setFormOpen(false);
      setFeedback(editing ? 'Tag atualizada.' : 'Tag criada.');
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Falha de rede.');
    } finally {
      setSaving(false);
    }
  }

  // Archive / Unarchive
  const [busyId, setBusyId] = useState<string | null>(null);

  async function archive(tag: WorkspaceTag) {
    const token = readAccessToken();
    if (!token) return;
    setBusyId(tag.id);
    try {
      const res = await fetch(`${EDGE}/v1/workspace-tags/${tag.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cascade: false }),
      });
      if (!res.ok) {
        setFeedback(`Falha ao arquivar (HTTP ${res.status}).`);
        return;
      }
      setFeedback(`Tag "${tag.name}" arquivada.`);
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function unarchive(tag: WorkspaceTag) {
    const token = readAccessToken();
    if (!token) return;
    setBusyId(tag.id);
    try {
      const res = await fetch(
        `${EDGE}/v1/workspace-tags/${tag.id}/unarchive`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        setFeedback(`Falha ao desarquivar (HTTP ${res.status}).`);
        return;
      }
      setFeedback(`Tag "${tag.name}" restaurada.`);
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  // Delete (cascade)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceTag | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    const token = readAccessToken();
    if (!token) return;
    setDeleting(true);
    try {
      const res = await fetch(`${EDGE}/v1/workspace-tags/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cascade: true }),
      });
      if (!res.ok) {
        setFeedback(`Falha ao excluir (HTTP ${res.status}).`);
        return;
      }
      setFeedback(`Tag "${deleteTarget.name}" excluída.`);
      setDeleteTarget(null);
      await reload();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Tags</h1>
          <p className="text-sm text-muted-foreground">
            Catálogo de tags do workspace. Atribua manualmente a contatos ou
            via tag_rules dos funis.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
          Nova tag
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar tag por nome…"
            className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          Mostrar arquivadas
        </label>
      </div>

      {/* Inline feedback bar */}
      {feedback && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-2 text-sm">
          {feedback}
        </div>
      )}

      {/* Results */}
      <div className="rounded-md border overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Carregando…
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-destructive">
              Falha ao carregar tags: {loadError}
            </p>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Tentar novamente
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <TagsIcon
              className="h-8 w-8 text-muted-foreground/50"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {debouncedQ
                ? 'Nenhuma tag encontrada com esse termo.'
                : showArchived
                  ? 'Nenhuma tag ainda. Crie sua primeira tag.'
                  : 'Nenhuma tag ativa. Crie uma tag ou mostre as arquivadas.'}
            </p>
            {!debouncedQ && (
              <Button variant="outline" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                Criar tag
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted">
                <th className="text-left px-4 py-3 font-normal">
                  <span className="text-xs font-medium text-muted-foreground">Tag</span>
                </th>
                <th className="text-left px-4 py-3 font-normal hidden md:table-cell">
                  <span className="text-xs font-medium text-muted-foreground">Descrição</span>
                </th>
                <th className="text-right px-4 py-3 font-normal w-px whitespace-nowrap">
                  <span className="text-xs font-medium text-muted-foreground"># Contatos</span>
                </th>
                <th className="text-left px-4 py-3 font-normal hidden lg:table-cell w-px whitespace-nowrap">
                  <span className="text-xs font-medium text-muted-foreground">Criada por</span>
                </th>
                <th className="text-left px-4 py-3 font-normal hidden lg:table-cell w-px whitespace-nowrap">
                  <span className="text-xs font-medium text-muted-foreground">Criada em</span>
                </th>
                <th className="text-left px-4 py-3 font-normal w-px whitespace-nowrap">
                  <span className="text-xs font-medium text-muted-foreground">Status</span>
                </th>
                <th className="w-px px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((tag) => {
                const archived = tag.archived_at !== null;
                const busy = busyId === tag.id;
                return (
                  <tr
                    key={tag.id}
                    className={`hover:bg-muted/50 transition-colors ${archived ? 'opacity-60' : ''}`}
                  >
                    <td className="px-4 py-3 align-middle">
                      <TagChip name={tag.name} color={tag.color} />
                    </td>
                    <td className="px-4 py-3 align-middle hidden md:table-cell max-w-md">
                      <p className="text-xs text-muted-foreground truncate">
                        {tag.description ?? <span className="italic">sem descrição</span>}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-middle text-right tabular-nums text-sm">
                      {typeof tag.lead_count === 'number'
                        ? tag.lead_count.toLocaleString('pt-BR')
                        : '—'}
                    </td>
                    <td className="px-4 py-3 align-middle hidden lg:table-cell whitespace-nowrap">
                      <span className="text-xs font-mono text-muted-foreground">
                        {shortenActor(tag.created_by)}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-middle hidden lg:table-cell whitespace-nowrap">
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatDate(tag.created_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-middle whitespace-nowrap">
                      {archived ? (
                        <Badge variant="secondary">Arquivada</Badge>
                      ) : (
                        <Badge variant="success">Ativa</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 align-middle whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(tag)}
                          disabled={busy}
                          aria-label={`Editar tag ${tag.name}`}
                          title="Editar"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                        {archived ? (
                          <button
                            type="button"
                            onClick={() => void unarchive(tag)}
                            disabled={busy}
                            aria-label={`Restaurar tag ${tag.name}`}
                            title="Desarquivar"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void archive(tag)}
                            disabled={busy}
                            aria-label={`Arquivar tag ${tag.name}`}
                            title="Arquivar"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <Archive className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(tag)}
                          disabled={busy}
                          aria-label={`Excluir tag ${tag.name}`}
                          title="Excluir"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Create / Edit sheet */}
      <TagFormSheet
        open={formOpen}
        onClose={closeForm}
        initial={formInitial}
        onSubmit={submitForm}
        saving={saving}
        error={formError}
      />

      {/* Destructive confirm */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir tag “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação apaga a tag e remove todas as{' '}
              <strong>
                {(deleteTarget?.lead_count ?? 0).toLocaleString('pt-BR')}
              </strong>{' '}
              aplicações em contatos. Sem desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting}>
              {deleting && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
              )}
              Excluir tag
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
