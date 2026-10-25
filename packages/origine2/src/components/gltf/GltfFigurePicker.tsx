import { useRef, useState } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import axios from 'axios';
import { t } from '@lingui/macro';
import ChooseFile from '@/pages/editor/ChooseFile/ChooseFile';
import { extNameMap } from '@/pages/editor/ChooseFile/chooseFileConfig';
import useEditorStore from '@/store/useEditorStore';
import { isGltfConfigPath, preferredFigure3D, rememberFigureMode } from '@/utils/gltf/gltfFigure';
import { ModelPreviewRoleContext } from '@/utils/gltf/ModelPreviewRoleContext';
import { splitFigureConfigs, figurePartConfig, figureCombinationError } from '@/utils/gltf/figureComposition';
import type { FigurePart, FigureRole } from '@/utils/gltf/figureComposition';
import assetStyles from '@/components/Assets/Assets.module.scss';

interface Props {
  value: string;
  enabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onOpen?: () => void;
}

/** Owns the uncommitted figure selection; the shared file browser only supplies files. */
export default function GltfFigurePicker({ value, enabled, placeholder, onChange, onOpen }: Props) {
  const gameName = useEditorStore.use.subPage();
  const [is3D, setIs3D] = useState(() => enabled && preferredFigure3D(value, placeholder));
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<FigureRole, FigurePart>>>({});
  const [role, setRole] = useState<FigureRole>('head');
  const [browsePath, setBrowsePath] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const reading = useRef(false);
  function markBusy(value: boolean) {
    reading.current = value;
    setBusy(value);
  }
  const compatibilityError = figureCombinationError(draft.head, draft.body);
  const report = (failure: unknown) =>
    setError(
      axios.isAxiosError(failure) ? String(failure.response?.data?.message ?? failure.message)
        : failure instanceof Error ? failure.message : String(failure),
    );
  const select = async (path: string, selectedRole?: FigureRole) =>
    (
      await axios.post('/api/manageGame/selectGltfModel', {
        gameName,
        path,
        ...(selectedRole ? { role: selectedRole } : {}),
      })
    ).data;

  function commit(path: string) {
    rememberFigureMode(is3D);
    onChange(path);
  }
  function begin() {
    const token = ++epoch.current;
    const use3D = enabled && preferredFigure3D(value, placeholder);
    setIs3D(use3D);
    setComposing(false);
    setDraft({});
    setRole('head');
    setError('');
    markBusy(false);
    const paths = use3D && isGltfConfigPath(value) ? splitFigureConfigs(value) : [];
    setBrowsePath(paths[0] ?? (!use3D && value !== placeholder && value !== 'none' ? value : undefined));
    onOpen?.();
    if (!paths.length) return;
    if (paths.length > 2) {
      setError('头身组合只能包含头部和身体两份配置。');
      return;
    }
    markBusy(true);
    void Promise.all(
      paths.map(async (path) => ({
        path,
        config: (await axios.get(`/games/${encodeURIComponent(gameName)}/game/3d/figure/${path}`)).data,
      })),
    )
      .then((configs) => {
        if (token !== epoch.current) return;
        const next: Partial<Record<FigureRole, FigurePart>> = {};
        configs.forEach(({ path, config }, index) => {
          const parts = figurePartConfig(config);
          for (const part of parts) {
            if (part.role !== 'head' && part.role !== 'body') continue;
            if (configs.length === 2 && part.role !== (index === 0 ? 'head' : 'body')) continue;
            next[part.role as FigureRole] = { ...part, configPath: path } as FigurePart;
          }
        });
        if (Object.keys(next).length) {
          setDraft(next);
          setComposing(true);
          setRole('head');
        }
      })
      .catch((failure) => {
        if (token === epoch.current) report(failure);
      })
      .finally(() => {
        if (token === epoch.current) markBusy(false);
      });
  }

  function card(partRole: FigureRole) {
    const part = draft[partRole],
      label = partRole === 'head' ? '头部' : '身体';
    const preview = part?.preview;
    return (
      <Tooltip
        key={partRole}
        relationship="description"
        content={
          <div style={{ maxWidth: 260 }}>
            {preview && (
              <img
                className={assetStyles.mosaicBg}
                src={preview}
                style={{ width: 240, maxHeight: 260, objectFit: 'contain' }}
              />
            )}
            <div>{part?.name ?? `尚未选择${label}`}</div>
            <div>{part?.description}</div>
          </div>
        }
      >
        <button
          type="button"
          aria-label={`选择${label}`}
          aria-pressed={role === partRole}
          disabled={busy}
          onClick={() => {
            setRole(partRole);
            setError('');
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            width: '100%',
            marginBottom: 10,
            border: role === partRole ? '2px solid var(--colorBrandStroke1)' : '1px solid var(--colorNeutralStroke1)',
            borderRadius: 6,
            padding: 8,
            background: 'var(--colorNeutralBackground1)',
            color: 'var(--colorNeutralForeground1)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <strong>{label}</strong>
          {preview ? (
            <img
              src={preview}
              className={assetStyles.mosaicBg}
              style={{ width: '100%', height: 96, objectFit: 'contain' }}
            />
          ) : (
            <div
              style={{
                height: 80,
                display: 'grid',
                placeItems: 'center',
                width: '100%',
                color: 'var(--colorNeutralForeground3)',
              }}
            >
              {part ? '暂无预览' : '尚未选择'}
            </div>
          )}
          <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {part?.name ?? `选择${label}`}
          </span>
        </button>
      </Tooltip>
    );
  }

  return (
    <ModelPreviewRoleContext.Provider value={is3D && composing ? role : undefined}>
      <ChooseFile
        title={placeholder}
        basePath={is3D ? ['3d', 'figure'] : ['figure']}
        deferClose
        selectionDisabled={busy}
        selectedFilePath={browsePath}
        chooseModelDirectory={is3D}
        onOpen={begin}
        onClose={() => {
          epoch.current++;
          markBusy(false);
        }}
        toolbar={
          enabled && (
            <>
              <span>{t`切换立绘类型`}</span>
              {[false, true].map((mode) => (
                <Button
                  key={String(mode)}
                  appearance={is3D === mode ? 'primary' : 'secondary'}
                  aria-pressed={is3D === mode}
                  onClick={() => {
                    epoch.current++;
                    rememberFigureMode(mode);
                    setIs3D(mode);
                    setComposing(false);
                    setDraft({});
                    setError('');
                    markBusy(false);
                    setBrowsePath(undefined);
                  }}
                >
                  {mode ? '3D' : '2D'}
                </Button>
              ))}
            </>
          )
        }
        sidebar={
          is3D && composing ? (
            <>
              {card('head')}
              {card('body')}
            </>
          ) : undefined
        }
        footer={(close) => (
          <div style={{ padding: '8px 12px', borderTop: 'var(--border-sm)' }}>
            {busy && <div role="status">正在读取模型…</div>}
            {(error || compatibilityError) && (
              <div role="alert" style={{ color: 'var(--colorPaletteRedForeground1)', whiteSpace: 'pre-wrap' }}>
                {error || compatibilityError}
              </div>
            )}
            {is3D && composing && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                <Button onClick={close}>取消</Button>
                <Button
                  appearance="primary"
                  disabled={busy || !draft.head || !draft.body || !!compatibilityError}
                  onClick={async () => {
                    if (!draft.head || !draft.body) return;
                    const token = ++epoch.current;
                    markBusy(true);
                    setError('');
                  const path = draft.head.configPath === draft.body.configPath
                    ? draft.head.configPath : `${draft.head.configPath}+${draft.body.configPath}`;
                    try {
                      const data = await select(path);
                      if (token !== epoch.current) return;
                      if (data.error) throw Error(String(data.error));
                      commit(path);
                      close();
                    } catch (failure) {
                      if (token === epoch.current) report(failure);
                    } finally {
                      if (token === epoch.current) markBusy(false);
                    }
                  }}
                >
                  确定
                </Button>
              </div>
            )}
          </div>
        )}
        fileFilter={is3D ? (file) => isGltfConfigPath(file.path) : undefined}
        extNames={[
          ...(extNameMap.get('image') ?? []),
          ...(extNameMap.get('json') ?? []),
          ...(extNameMap.get('video') ?? []),
        ]}
        onChange={async (file) => {
          if (!file) return false;
          if (reading.current) return false;
          if (!is3D) {
            commit(file.name);
            return true;
          }
          const token = ++epoch.current;
          setError('');
          markBusy(true);
          const path = file.isDir ? `${file.name}/config.json` : file.name;
          try {
            const followBody = composing && role === 'head' && !!draft.head
              && draft.head.configPath === draft.body?.configPath;
            const data = await select(path, composing && !followBody ? role : undefined);
            if (token !== epoch.current) return false;
            if (data.error) throw Error(String(data.error));
            if (data.role === 'integrated') {
              commit(path);
              return true;
            }
            if (followBody && !data.selectionParts?.some((part: FigurePart) => part.role === 'head'))
              throw Error('所选模型包只包含身体');
            const next = { ...draft };
            if (followBody) delete next.body;
            for (const part of data.selectionParts ?? [])
              if (part.role === 'head' || part.role === 'body')
                next[part.role as FigureRole] = { ...part, configPath: path };
            setDraft(next);
            setComposing(true);
            if (!next.head) setRole('head');
            else if (!next.body) setRole('body');
            return false;
          } catch (failure) {
            if (token === epoch.current) report(failure);
            return false;
          } finally {
            if (token === epoch.current) markBusy(false);
          }
        }}
      />
    </ModelPreviewRoleContext.Provider>
  );
}
