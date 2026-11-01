// Generated file. Do not edit by hand; regenerate from its source of record. Source: commands.


/** Every user-visible action. One table: labels, membership test, description. */
export const commandLabels = {
  'select': 'Select',
  'rectangle': 'Rectangle',
  'pushpull': 'Push/Pull',
  'line': 'Line',
  'tape': 'Tape',
  'dimension': 'Dimension',
  'followme': 'Follow Me',
  'offset': 'Offset',
  'delete': 'Delete',
  'duplicate': 'Duplicate',
  'array': 'Array',
  'union': 'Union',
  'subtract': 'Subtract',
  'intersect': 'Intersect',
  'fit': 'Fit to Envelope',
  'undo': 'Undo',
  'redo': 'Redo',
} as const;

export type CommandId = keyof typeof commandLabels;

/** Every user-visible action. One table: labels, membership test, description. */
export const commandAll: readonly CommandId[] = ['select', 'rectangle', 'pushpull', 'line', 'tape', 'dimension', 'followme', 'offset', 'delete', 'duplicate', 'array', 'union', 'subtract', 'intersect', 'fit', 'undo', 'redo'];

/** Every user-visible action. One table: labels, membership test, description. */
export function isCommand(id: string): id is CommandId {
  return Object.prototype.hasOwnProperty.call(commandLabels, id);
}

/** Every user-visible action. One table: labels, membership test, description. Unknown ids are refused, never forwarded. */
export function commandDescribe(id: CommandId): { readonly id: CommandId; readonly label: string } {
  switch (id) {
    case 'select':
      return { id: 'select', label: commandLabels['select'] };
    case 'rectangle':
      return { id: 'rectangle', label: commandLabels['rectangle'] };
    case 'pushpull':
      return { id: 'pushpull', label: commandLabels['pushpull'] };
    case 'line':
      return { id: 'line', label: commandLabels['line'] };
    case 'tape':
      return { id: 'tape', label: commandLabels['tape'] };
    case 'dimension':
      return { id: 'dimension', label: commandLabels['dimension'] };
    case 'followme':
      return { id: 'followme', label: commandLabels['followme'] };
    case 'offset':
      return { id: 'offset', label: commandLabels['offset'] };
    case 'delete':
      return { id: 'delete', label: commandLabels['delete'] };
    case 'duplicate':
      return { id: 'duplicate', label: commandLabels['duplicate'] };
    case 'array':
      return { id: 'array', label: commandLabels['array'] };
    case 'union':
      return { id: 'union', label: commandLabels['union'] };
    case 'subtract':
      return { id: 'subtract', label: commandLabels['subtract'] };
    case 'intersect':
      return { id: 'intersect', label: commandLabels['intersect'] };
    case 'fit':
      return { id: 'fit', label: commandLabels['fit'] };
    case 'undo':
      return { id: 'undo', label: commandLabels['undo'] };
    case 'redo':
      return { id: 'redo', label: commandLabels['redo'] };
  }
}
