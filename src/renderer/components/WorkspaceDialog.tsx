import { useEffect, useRef, useState } from 'react';
import type { ProjectFolderSelection, Workspace, WorkspaceCreationIntent } from '@/contracts';
import { Button } from './Button';
import { Dialog } from './Menu';
import { useT } from '../i18n';

/** 表单只持有选择回执和草稿；正式空间与保存结果由应用发布。 */
export function WorkspaceDialog({ onClose, onCreated, initialIntent }: { onClose: () => void; onCreated: (workspace: Workspace) => void; initialIntent?: WorkspaceCreationIntent | null }) {
  const t = useT();
  const operation = useRef(initialIntent?.operationId ?? crypto.randomUUID());
  const currentRequest = useRef<string | null>(null);
  const alive = useRef(true);
  const saveFlight = useRef(false);
  const [name, setName] = useState(initialIntent?.name ?? '');
  const [selection, setSelection] = useState<ProjectFolderSelection | null>(initialIntent ? { ...initialIntent, requestId: 'readback' } : null);
  const [readback, setReadback] = useState(Boolean(initialIntent));
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    const id = operation.current;
    return () => { alive.current = false; void window.dcode.discardProjectFolder({ operationId: id }).catch(() => undefined); };
  }, []);
  const close = () => { alive.current = false; currentRequest.current = null; onClose(); };
  const choose = async () => {
    if (currentRequest.current || saveFlight.current) return;
    const requestId = crypto.randomUUID(); currentRequest.current = requestId;
    setChoosing(true); setError(null);
    try {
      const next = await window.dcode.chooseProjectFolder({ operationId: operation.current, requestId });
      if (!alive.current || currentRequest.current !== requestId) return;
      if (next) {
        if (next.operationId !== operation.current || next.requestId !== requestId) throw new Error();
        setSelection(next);
        setName(previous => previous || next.path.split('/').filter(Boolean).at(-1) || '');
      }
    } catch { if (alive.current && currentRequest.current === requestId) setError(t('workspace.chooseFailed')); }
    finally {
      if (alive.current && currentRequest.current === requestId) { currentRequest.current = null; setChoosing(false); }
    }
  };
  const create = async () => {
    if (!selection || !name.trim() || currentRequest.current || saveFlight.current) return;
    saveFlight.current = true; setSaving(true); setError(null);
    try {
      const workspace = await window.dcode.createWorkspace({ operationId: operation.current, selectionId: selection.selectionId, name: name.trim() });
      if (!alive.current) return;
      onCreated(workspace); close();
    } catch (cause) {
      if (alive.current) {
        const message = cause instanceof Error ? cause.message : '';
        if (message.includes('project-binding-save-failed')) {
          // 已确认未存才能修改意图；重开核对的旧选择已在关闭时失效，须重新真实选取。
          if (readback && initialIntent) setSelection(null);
          setReadback(false);
        } else if (!message.includes('project-folder-')) setReadback(true);
        setError(t(message.includes('project-binding-save-failed') ? readback && initialIntent ? 'workspace.notSaved' : 'workspace.saveFailed'
          : message.includes('project-folder-') ? 'workspace.chooseAgain'
          : message.includes('project-binding-identity-conflict') ? 'workspace.creationChanged' : 'workspace.saveUnknown'));
      }
    } finally { saveFlight.current = false; if (alive.current) setSaving(false); }
  };
  return <Dialog title={t('workspace.createTitle')} onClose={close} actions={<>
    <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={saving || choosing || !selection || !name.trim()} aria-busy={saving} onClick={() => void create()}>
      {t(saving ? 'workspace.saving' : readback ? 'workspace.check' : 'common.create')}
    </Button>
  </>}>
    <label className="flex flex-col gap-1 text-ui-sm">
      {t('workspace.name')}
      <input className="rounded-md bg-background px-3 py-2 ring-1 ring-[var(--edge)]" maxLength={120} value={name} disabled={saving || readback} onChange={event => setName(event.target.value)} />
    </label>
    <div className="mt-3 flex flex-col gap-2">
      <Button disabled={choosing || saving || readback} aria-busy={choosing} onClick={() => void choose()}>{t(choosing ? 'workspace.choosing' : 'workspace.choose')}</Button>
      <p className="break-all text-ui-xs text-subtle" data-slot="workspace-selected-folder">{selection?.path ?? t('workspace.noFolder')}</p>
    </div>
    {error && <p role="alert" className="mt-2 text-ui-sm text-destructive">{error}</p>}
  </Dialog>;
}
