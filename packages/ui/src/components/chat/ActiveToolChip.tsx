import styles from './ActiveToolChip.module.css';

const TOOL_LABELS: Record<string, string> = {
  server_info:  'Consultando servidor…',
  media_query:  'Buscando en biblioteca…',
  library_ops:  'Gestionando archivos…',
  series:       'Consultando Sonarr…',
  movies:       'Consultando Radarr…',
  downloads:    'Revisando descargas…',
  optimize:     'Analizando medios…',
  maintenance:  'Ejecutando mantenimiento…',
};

export function ActiveToolChip({ name }: { name: string }) {
  const label = TOOL_LABELS[name] ?? `${name}…`;
  return (
    <div className={styles.chip}>
      <div className={styles.spinner} />
      <span>{label}</span>
    </div>
  );
}
