export function truncateLargeData(data: any, maxLen: number = 2000): any {
  if (!data) return data;
  try {
    const str = JSON.stringify(data);
    if (str.length <= maxLen) return data;
    return { _truncated: true, _original_length: str.length, message: "Data was too large and has been omitted to save space." };
  } catch {
    return { _truncated: true, message: "Could not stringify data." };
  }
}
