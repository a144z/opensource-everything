// Generated file. Do not edit by hand; regenerate from its source of record. Source: commands.


/** Every user-visible action. One table: labels, shortcuts, membership test. */
export const commandLabels = {
  'select': 'Select',
  'rectangle': 'Rectangle',
  'rotatedRectangle': 'Rotated Rectangle',
  'circle': 'Circle',
  'arc': 'Arc',
  'line': 'Line',
  'pushpull': 'Push/Pull',
  'offset': 'Offset',
  'followme': 'Follow Me',
  'move': 'Move',
  'rotate': 'Rotate',
  'scale': 'Scale',
  'paint': 'Paint',
  'eraser': 'Eraser',
  'tape': 'Tape',
  'dimension': 'Dimension',
  'delete': 'Delete',
  'duplicate': 'Duplicate',
  'instance': 'Make Instance',
  'array': 'Array',
  'union': 'Union',
  'subtract': 'Subtract',
  'intersect': 'Intersect',
  'fit': 'Fit to Envelope',
  'viewIso': 'View: Isometric',
  'viewTop': 'View: Top',
  'viewFront': 'View: Front',
  'viewRight': 'View: Right',
  'viewBack': 'View: Back',
  'viewLeft': 'View: Left',
  'viewBottom': 'View: Bottom',
  'zoomExtents': 'Zoom Extents',
  'projectionOrtho': 'Projection: Orthographic',
  'projectionPersp': 'Projection: Perspective',
  'viewShaded': 'Style: Shaded',
  'viewHiddenLine': 'Style: Hidden Line',
  'viewEdges': 'Style: Edges Only',
  'toggleShadows': 'Toggle Shadows',
  'toggleAxes': 'Toggle Axes',
  'undo': 'Undo',
  'redo': 'Redo',
} as const;

export type CommandId = keyof typeof commandLabels;

/** Every user-visible action. One table: labels, shortcuts, membership test. Keyboard shortcut per command; a command with none is absent. */
export const commandKeys: Partial<Record<CommandId, string>> = {
  'select': ' ',
  'rectangle': 'r',
  'rotatedRectangle': 'Alt+r',
  'circle': 'c',
  'arc': 'a',
  'line': 'l',
  'pushpull': 'p',
  'offset': 'o',
  'followme': 'f',
  'move': 'q',
  'rotate': 'i',
  'scale': 's',
  'paint': 'b',
  'eraser': 'e',
  'tape': 'm',
  'dimension': 'd',
  'delete': 'Delete',
  'viewIso': 'Ctrl+0',
  'viewTop': 'Ctrl+1',
  'viewFront': 'Ctrl+2',
  'viewRight': 'Ctrl+3',
  'viewBack': 'Ctrl+4',
  'viewLeft': 'Ctrl+5',
  'viewBottom': 'Ctrl+6',
  'zoomExtents': 'z',
  'projectionOrtho': 'Ctrl+7',
  'projectionPersp': 'Ctrl+8',
  'undo': 'Ctrl+Z',
  'redo': 'Ctrl+Shift+Z',
};

/** Every user-visible action. One table: labels, shortcuts, membership test. */
export const commandAll: readonly CommandId[] = ['select', 'rectangle', 'rotatedRectangle', 'circle', 'arc', 'line', 'pushpull', 'offset', 'followme', 'move', 'rotate', 'scale', 'paint', 'eraser', 'tape', 'dimension', 'delete', 'duplicate', 'instance', 'array', 'union', 'subtract', 'intersect', 'fit', 'viewIso', 'viewTop', 'viewFront', 'viewRight', 'viewBack', 'viewLeft', 'viewBottom', 'zoomExtents', 'projectionOrtho', 'projectionPersp', 'viewShaded', 'viewHiddenLine', 'viewEdges', 'toggleShadows', 'toggleAxes', 'undo', 'redo'];

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
    case 'rotatedRectangle':
      return { id: 'rotatedRectangle', label: commandLabels['rotatedRectangle'] };
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
    case 'scale':
      return { id: 'scale', label: commandLabels['scale'] };
    case 'paint':
      return { id: 'paint', label: commandLabels['paint'] };
    case 'eraser':
      return { id: 'eraser', label: commandLabels['eraser'] };
    case 'tape':
      return { id: 'tape', label: commandLabels['tape'] };
    case 'dimension':
      return { id: 'dimension', label: commandLabels['dimension'] };
    case 'delete':
      return { id: 'delete', label: commandLabels['delete'] };
    case 'duplicate':
      return { id: 'duplicate', label: commandLabels['duplicate'] };
    case 'instance':
      return { id: 'instance', label: commandLabels['instance'] };
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
    case 'viewIso':
      return { id: 'viewIso', label: commandLabels['viewIso'] };
    case 'viewTop':
      return { id: 'viewTop', label: commandLabels['viewTop'] };
    case 'viewFront':
      return { id: 'viewFront', label: commandLabels['viewFront'] };
    case 'viewRight':
      return { id: 'viewRight', label: commandLabels['viewRight'] };
    case 'viewBack':
      return { id: 'viewBack', label: commandLabels['viewBack'] };
    case 'viewLeft':
      return { id: 'viewLeft', label: commandLabels['viewLeft'] };
    case 'viewBottom':
      return { id: 'viewBottom', label: commandLabels['viewBottom'] };
    case 'zoomExtents':
      return { id: 'zoomExtents', label: commandLabels['zoomExtents'] };
    case 'projectionOrtho':
      return { id: 'projectionOrtho', label: commandLabels['projectionOrtho'] };
    case 'projectionPersp':
      return { id: 'projectionPersp', label: commandLabels['projectionPersp'] };
    case 'viewShaded':
      return { id: 'viewShaded', label: commandLabels['viewShaded'] };
    case 'viewHiddenLine':
      return { id: 'viewHiddenLine', label: commandLabels['viewHiddenLine'] };
    case 'viewEdges':
      return { id: 'viewEdges', label: commandLabels['viewEdges'] };
    case 'toggleShadows':
      return { id: 'toggleShadows', label: commandLabels['toggleShadows'] };
    case 'toggleAxes':
      return { id: 'toggleAxes', label: commandLabels['toggleAxes'] };
    case 'undo':
      return { id: 'undo', label: commandLabels['undo'] };
    case 'redo':
      return { id: 'redo', label: commandLabels['redo'] };
  }
}
