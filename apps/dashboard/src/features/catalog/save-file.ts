/**
 * Hands the seller a file through the browser's own download (P1-23, P1-30).
 *
 * One function for every file the console writes, so the object URL is always
 * released: a URL left behind keeps its whole file in memory for as long as the
 * tab stays open, and a catalogue export is megabytes of it.
 *
 * Components take it as an injectable prop, because a test can read a string
 * and cannot read a download.
 */
export const saveTextFile = (text: string, filename: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
