import { AppWindow, Bot, BrainCircuit, Plug, Boxes, Circle, Cog, Container, Database, Diamond, Globe, HardDrive, Layers, ListOrdered, Monitor, Puzzle, Server, Shield, Smartphone, Split, SquareCheck, User, Workflow, Zap, type LucideIcon } from "lucide-react";
import { objectType } from "@/lib/catalog";
import { componentById } from "@/lib/library";
import { LIBRARY_ICONS } from "./libraryIcons";

const ICONS: Record<string, LucideIcon> = {
  layers: Layers,
  user: User,
  boxes: Boxes,
  globe: Globe,
  app: AppWindow,
  monitor: Monitor,
  phone: Smartphone,
  cog: Cog,
  database: Database,
  queue: ListOrdered,
  zap: Zap,
  drive: HardDrive,
  split: Split,
  server: Server,
  container: Container,
  shield: Shield,
  puzzle: Puzzle,
  bot: Bot,
  brain: BrainCircuit,
  plug: Plug,
  workflow: Workflow,
  task: SquareCheck,
  event: Circle,
  decision: Diamond,
};

/** An object's icon: its library component's when it was made from one, otherwise its type's. */
export function TypeIcon({ typeId, componentId, size = 16 }: { typeId: string; componentId?: string; size?: number }) {
  const component = componentById(componentId);
  const Icon = (component && LIBRARY_ICONS[component.icon]) || ICONS[objectType(typeId).icon] || AppWindow;
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}

/** A library icon by its Lucide name. */
export function LibraryIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = LIBRARY_ICONS[name] ?? AppWindow;
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}
