/** Límites de la importación (spec, apartado 3.1 y 7). Un único sitio para servicios y tests. */
export const IMPORT_LIMITS = {
  /** Tamaño máximo del fichero subido. */
  MAX_FILE_BYTES: 5 * 1024 * 1024,
  /** Filas de datos (sin la cabecera). */
  MAX_DATA_ROWS: 2000,
  MAX_COLUMNS: 50,
  /** Longitud máxima que se conserva de una celda (ningún campo importable supera 160). */
  MAX_CELL_CHARS: 1000,
  /** XLSX (un ZIP): límites aplicados MIENTRAS se descomprime, no después. */
  MAX_ZIP_ENTRIES: 2000,
  MAX_XLSX_PART_BYTES: 40 * 1024 * 1024,
  MAX_XLSX_TOTAL_BYTES: 60 * 1024 * 1024,
  /** Bloques transaccionales de la confirmación y del deshacer. */
  BLOCK_SIZE: 100,
  /** Vida del fichero temporal cifrado. */
  PAYLOAD_TTL_MS: 24 * 60 * 60 * 1000,
  /** Plazo para deshacer un lote. */
  REVERT_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  /** Timeout de cada transacción de bloque. */
  BLOCK_TX_TIMEOUT_MS: 30_000,
} as const;
