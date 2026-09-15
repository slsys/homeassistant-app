// Keep controller precision for live rows; cache labels already contain it.
window.slsLogTime = (event) => {
  if (event.timeLabel) return event.timeLabel;
  const date = new Date(event.time);
  if (!Number.isFinite(date.getTime())) return '—';
  return (
    date.toLocaleTimeString('ru-RU', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) +
    '.' +
    String(date.getMilliseconds()).padStart(3, '0')
  );
};
