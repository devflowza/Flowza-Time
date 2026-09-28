/** Save a text export (CSV built by the API and returned inline) as a file. */
export function saveTextFile(file: { fileName: string; contentType: string; content: string }) {
  const blob = new Blob([file.content], { type: `${file.contentType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file.fileName; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
