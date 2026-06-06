const BEIJING_TZ = 'Asia/Shanghai';

/**
 * 格式化为北京时间：YYYY-MM-DD HH:mm:ss
 * @param {Date|number|string} input
 */
export function formatBeijingTime(input = Date.now()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input ?? '');

  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
