// Generated file. Do not edit by hand; regenerate from its source of record. Source: commands.


/** Every user-visible action. One table: labels, shortcuts, membership test. */
export const commandLabels = {
  'select': 'Select',
  'rectangle': 'Rectangle',
  'circle': 'Circle',
  'arc': 'Arc',
  'line': 'Line',
  'pushpull': 'Push/Pull',
  'offset': 'Offset',
  'followme': 'Follow Me',
  'move': 'Move',
  'rotate': 'Rotate',
  'tape': 'Tape',
  'dimension': 'Dimension',
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

/** Every user-visible action. One table: labels, shortcuts, membership test. Keyboard shortcut per command; a command with none is absent. */
export const commandKeys: Partial<Record<CommandId, string>> = {
  'select': ' ',
  'rectangle': 'r',
  'circle': 'c',
  'arc': 'a',
  'line': 'l',
  'pushpull': 'p',
  'offset': 'o',
  'followme': 'f',
  'move': 'q',
  'rotate': 'i',
  'tape': 'm',
  'dimension': 'd',
  'delete': 'Delete',
  'undo': 'Ctrl+Z',
  'redo': 'Ctrl+Shift+Z',
};

/** Every user-visible action. One table: labels, shortcuts, membership test. */
export const commandAll: readonly CommandId[] = ['select', 'rectangle', 'circle', 'arc', 'line', 'pushpull', 'offset', 'followme', 'move', 'rotate', 'tape', 'dimension', 'delete', 'duplicate', 'array', 'union', 'subtract', 'intersect', 'fit', 'undo', 'redo'];

/** Every user-visible action. One table: labels, shortcuts, membership test. */
export function isCommand(id: string): id is CommandId {
  return Object.prototype.hasOwnProperty.call(commandLabels, id);
}

/** Every user-visible action. One table: labels, shortcuts, membership test. Unknown ids are refused, never forwarded. */
export function commandDescribe(id: CommandId): { readonly id: CommandId; readonly label: string } {
  switch (id) {
    case 'select':
      return { id: 'select', label: commandLabels['select'] };
    case 'rectangle':
      return { id: 'rectangle', label: commandLabels['rectangle'] };
    case 'circle':
      return { id: 'circle', label: commandLabels['circle'] };
    case 'arc':
      return { id: 'arc', label: commandLabels['arc'] };
    case 'line':
      return { id: 'line', label: commandLabels['line'] };
    case 'pushpull':
      return { id: 'pushpull', label: commandLabels['pushpull'] };
    case 'offset':
      return { id: 'offset', label: commandLabels['offset'] };
    case 'followme':
      return { id: 'followme', label: commandLabels['followme'] };
    case 'move':
      return { id: 'move', label: commandLabels['move'] };
    case 'rotate':
      return { id: 'rotate', label: commandLabels['rotate'] };
    case 'tape':
      return { id: 'tape', label: commandLabels['tape'] };
    case 'dimension':
      return { id: 'dimension', label: commandLabels['dimension'] };
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
