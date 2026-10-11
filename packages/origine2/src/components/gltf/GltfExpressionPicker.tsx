import { useState } from 'react';
import { Button, Popover, PopoverSurface, PopoverTrigger } from '@fluentui/react-components';
import SearchableCascader from '@/pages/editor/GraphicalEditor/components/SearchableCascader';
import { decodeNativeExpression, encodeNativeExpression, NativeExpressionOptions, NativeExpressionSelection } from '@/utils/gltf/gltfFigure';
import styles from './gltfExpressionPicker.module.scss';
import { preferredExpressionMode, rememberExpressionMode } from '@/utils/gltf/gltfFigure';

interface Props {
  native: NativeExpressionOptions;
  live2d: string[];
  supportsLive2D: boolean;
  value: string;
  onOpen?: () => void;
  onValueChange: (value: string) => void;
}
export function initialExpressionMode(value: string, supportsLive2D: boolean, live2d: string[]): '3d' | 'live2d' {
  return preferredExpressionMode(value, supportsLive2D, live2d);
}
export default function GltfExpressionPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const [chosenMode, setMode] = useState<'3d' | 'live2d' | undefined>();
  const [draft, setDraft] = useState<NativeExpressionSelection>({});
  const [level, setLevel] = useState(0);
  const [search, setSearch] = useState(['', '', '']);
  const selected = decodeNativeExpression(props.value);
  const mode = props.supportsLive2D ? chosenMode ?? initialExpressionMode(props.value, true, props.live2d) : '3d';
  const columns = props.native.faces?.length ? [
    { key: 'face' as const, title: '3D表情', names: props.native.faces },
  ] : [
    { key: 'eye' as const, title: '3D眼型', names: props.native.eyes },
    { key: 'closed' as const, title: '3D闭口', names: props.native.mouths },
    { key: 'open' as const, title: '3D张口', names: props.native.mouths },
  ];
  return <Popover open={open} onOpenChange={(_, data) => {
    if (data.open) {
      props.onOpen?.();
      setMode(undefined);
      const existing = decodeNativeExpression(props.value);
      const initial = existing ?? props.native.defaults;
      setDraft({ ...(initial.eye ? props.native.mouthDefaults?.[initial.eye] : {}), ...initial });
      setLevel(existing ? columns.length - 1 : 0);
      setSearch(['', '', '']);
    }
    setOpen(data.open);
  }} positioning="after" withArrow>
    <PopoverTrigger disableButtonEnhancement>
      <Button className={styles.trigger}>{selected ? selected.face ?? [selected.eye, selected.closed, selected.open].map(name => name || '无').join(' / ') : props.value || '选择表情'}</Button>
    </PopoverTrigger>
    <PopoverSurface className={styles.surface}>
      {props.supportsLive2D && <div className={styles.modes} aria-label="切换表情类型">
        <Button appearance={mode === '3d' ? 'primary' : 'secondary'} onClick={() => { rememberExpressionMode('3d'); setMode('3d'); }}>3D</Button>
        <Button appearance={mode === 'live2d' ? 'primary' : 'secondary'} onClick={() => { rememberExpressionMode('live2d'); setMode('live2d'); }}>Live2D</Button>
      </div>}
      {mode === 'live2d' && props.supportsLive2D ? <SearchableCascader optionList={props.live2d}
        value={props.value.startsWith('3d:') ? '' : props.value} onValueChange={value => {
          if (value) { rememberExpressionMode('live2d'); props.onValueChange(value); setOpen(false); }
        }} /> : <div className={styles.columns}>
        {columns.map((column, index) => <div className={styles.column} key={column.key}>
          <div className={styles.heading}>{column.title}</div>
          {column.names.length > 0 && <input aria-label={`搜索${column.title}`} placeholder="搜索…" value={search[index]}
            onChange={event => setSearch(previous => previous.map((value, i) => i === index ? event.target.value : value))} />}
          {(column.names.length ? column.names.filter(name => name.toLocaleLowerCase().includes(search[index].toLocaleLowerCase())) : ['']).map(name => <Button key={name}
            disabled={index > level} aria-pressed={draft[column.key] === name} appearance={draft[column.key] === name ? 'primary' : 'subtle'}
            onClick={() => {
              const next = { ...draft, ...(column.key === 'eye' ? props.native.mouthDefaults?.[name] : {}), [column.key]: name || undefined };
              setDraft(next);
              setLevel(index + 1);
              if (index === columns.length - 1) {
                if (props.supportsLive2D) rememberExpressionMode('3d');
                props.onValueChange(encodeNativeExpression(next)); setOpen(false);
              }
            }}>{name || '无'}</Button>)}
        </div>)}
      </div>}
    </PopoverSurface>
  </Popover>;
}
