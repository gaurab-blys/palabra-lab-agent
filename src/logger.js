/**
 * Minimal JSON logger for grepping latency and stream events during analysis.
 */

const formatMeta = (meta) => {
  if (meta === undefined) return '';
  if (meta instanceof Error) return meta.message;
  if (typeof meta === 'object') {
    try {
      return ` ${JSON.stringify(meta)}`;
    } catch (e) {
      return ` ${String(meta)}`;
    }
  }
  return ` ${String(meta)}`;
};

const log = (level, message, meta) => {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${formatMeta(meta)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
