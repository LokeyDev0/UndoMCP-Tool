export function generateActionLabel(toolName: string, args: Record<string, any>): string {
  if (/write|create|edit|delete|remove|move|rename|copy|append|overwrite|patch/i.test(toolName)
      && /file|directory|dir|mkdir/i.test(toolName)) {
    const filePath = args.path || args.file || args.filePath || args.TargetFile || args.filename || '';
    if (filePath) return `${toolName}: ${filePath}`;
  }

  if (/run[_-]?command|execute[_-]?command/i.test(toolName)) {
    const cmd = args.command || args.CommandLine || '';
    if (cmd) return `${toolName}: ${String(cmd).slice(0, 80)}`;
  }

  const title = args.title || args.name || args.subject || args.label;
  if (typeof title === 'string' && title.length > 0) {
    return `${toolName}: "${title.length > 60 ? title.slice(0, 57) + '...' : title}"`;
  }

  if (args.properties && typeof args.properties === 'object') {
    for (const val of Object.values(args.properties)) {
      if (typeof val === 'string' && val.length > 0) {
        return `${toolName}: "${val.length > 60 ? (val as string).slice(0, 57) + '...' : val}"`;
      }
      if (Array.isArray(val)) {
        const text = (val[0] as any)?.text?.content || (val[0] as any)?.plain_text;
        if (typeof text === 'string' && text.length > 0) {
          return `${toolName}: "${text.length > 60 ? text.slice(0, 57) + '...' : text}"`;
        }
      }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const prop = val as any;
        const arr = prop.title || prop.rich_text;
        if (Array.isArray(arr)) {
          const text = arr[0]?.text?.content || arr[0]?.plain_text;
          if (typeof text === 'string' && text.length > 0) {
            return `${toolName}: "${text.length > 60 ? text.slice(0, 57) + '...' : text}"`;
          }
        }
      }
    }
  }

  if (args.path || args.file || args.filename) {
    return `${toolName} on ${args.path || args.file || args.filename}`;
  }
  if (args.id || args.name) {
    return `${toolName} (${args.id || args.name})`;
  }

  return `Call ${toolName}`;
}
