import {
  CircleCheck,
  FolderOpen,
  ListTree,
  LoaderCircle,
  RefreshCw,
  createElement,
  type IconNode,
} from 'lucide'

const iconNodes = {
  CircleCheck,
  FolderOpen,
  ListTree,
  LoaderCircle,
  RefreshCw,
} satisfies Record<string, IconNode>

export type IconName = keyof typeof iconNodes

export function icon(name: IconName, size = 16): SVGElement {
  const node = iconNodes[name]
  return createElement(node, {
    width: size,
    height: size,
    'stroke-width': 1.8,
    'aria-hidden': 'true',
  })
}
