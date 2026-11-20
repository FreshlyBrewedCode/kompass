// Hands a Blob to the user as a file download (an anchor with `download`; works in iOS Safari too).
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // the download has started by the time this fires; the Blob is released after
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function backupFilename(now: Date = new Date()): string {
  return `kompass-rides-${now.toISOString().slice(0, 10)}.kompassrides`;
}
